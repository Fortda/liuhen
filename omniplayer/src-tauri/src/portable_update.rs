//! 便携增量更新：只替换 OmniPlayer.exe（及旁路采集 exe），绝不触碰 OmniDatabase。
//!
//! GitHub owner/repo 与前端 `shell_links.ts` 对齐（Fortda/liuhen）。
//! 仓库尚未 rename 时 latest API 会 404。旧资源名 `OmniTrace-*` 仍认。
//! 只拉 Release 的 zip（优先 `*-windows-x64-update.zip`），写入 exe 旁 `incoming\`，再走本文件 apply。

use futures_util::StreamExt;
use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::Emitter;

/// 与 `omniplayer/src/shell_links.ts` 同步；禁止从非本仓库 URL 下载。
/// 默认 Fortda/liuhen。尚未 `gh repo rename` 时检查更新会 404。
const GITHUB_OWNER: &str = "Fortda";
const GITHUB_REPO: &str = "liuhen";
const GITHUB_REPO_LEGACY: &str = "omnitrace";

const UPDATE_MSG: &str =
    "已准备更新，请关闭并重启 OmniPlayer（数据目录 OmniDatabase 不会被改动）";

#[derive(Serialize)]
pub struct PendingPortableUpdate {
    pub path: String,
    pub source: String,
}

#[derive(Serialize)]
pub struct GithubUpdateInfo {
    pub current_version: String,
    pub latest_tag: String,
    pub latest_version: String,
    pub newer: bool,
    pub asset_name: String,
    pub asset_size: u64,
    pub incoming: Option<PendingPortableUpdate>,
}

#[derive(Clone, Serialize)]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub asset_name: String,
}

fn path_contains_omnibase(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(s) => {
            let n = s.to_string_lossy();
            n.eq_ignore_ascii_case("OmniDatabase")
        }
        _ => false,
    })
}

fn is_omniplayer_exe_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("OmniPlayer.exe") || name.eq_ignore_ascii_case("omniplayer.exe")
}

fn same_path(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        return ca == cb;
    }
    a == b
}

#[cfg(windows)]
fn spawn_update_bat(bat_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    Command::new("cmd")
        .args(["/C", &bat_path.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|e| format!("无法启动更新脚本：{e}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_update_bat(_bat_path: &Path) -> Result<(), String> {
    Err("便携增量更新仅支持 Windows".into())
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

/// 同路径已排除后：长度不同必新；长度相同再比内容，避免安装残留 twin 误报「可更新」。
fn looks_like_newer_exe(path: &Path, current: &Path) -> bool {
    let Some(new_len) = file_len(path) else {
        return false;
    };
    let Some(cur_len) = file_len(current) else {
        return true;
    };
    if new_len != cur_len {
        return true;
    }
    match (fs::read(path), fs::read(current)) {
        (Ok(a), Ok(b)) => a != b,
        _ => true,
    }
}

fn is_usable_update_exe(path: &Path, current: &Path) -> bool {
    path.is_file()
        && !same_path(path, current)
        && !path_contains_omnibase(path)
        && looks_like_newer_exe(path, current)
}

fn incoming_dir() -> Result<PathBuf, String> {
    let dir = crate::current_exe_dir().ok_or_else(|| "找不到程序所在目录".to_string())?;
    if path_contains_omnibase(&dir) {
        return Err("拒绝：当前程序位于 OmniDatabase 内，无法安全更新".into());
    }
    let incoming = dir.join("incoming");
    if path_contains_omnibase(&incoming) {
        return Err("拒绝：incoming 位于 OmniDatabase 内".into());
    }
    fs::create_dir_all(&incoming).map_err(|e| format!("无法创建 incoming：{e}"))?;
    Ok(incoming)
}

/// 探测 incoming 或仓库 dist 里待换上的 OmniPlayer.exe。
#[tauri::command]
pub fn probe_portable_update() -> Option<PendingPortableUpdate> {
    let current = std::env::current_exe().ok()?;
    let mut cands: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(dir) = crate::current_exe_dir() {
        cands.push((dir.join("incoming").join("OmniPlayer.exe"), "incoming"));
    }
    if let Some(db) = crate::read_install_data_root_pointer() {
        if let Some(repo) = db.parent() {
            cands.push((
                repo.join("dist").join("OmniPlayer").join("OmniPlayer.exe"),
                "dist",
            ));
        }
    }
    for (path, source) in cands {
        if is_usable_update_exe(&path, &current) {
            return Some(PendingPortableUpdate {
                path: path.to_string_lossy().into_owned(),
                source: source.to_string(),
            });
        }
    }
    None
}

/// 将新 exe 准备为旁路替换：写 `.new` + `update_omniplayer.bat`，进程退出后 bat 换文件并拉起新壳。
#[tauri::command]
pub fn apply_portable_update(new_exe_path: String) -> Result<String, String> {
    let new_path = PathBuf::from(new_exe_path.trim());
    if !new_path.is_file() {
        return Err(format!("找不到新程序文件：{}", new_path.display()));
    }

    let file_name = new_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无效的文件名".to_string())?;
    if !is_omniplayer_exe_name(file_name) {
        return Err("新文件名必须是 OmniPlayer.exe（或 omniplayer.exe）".into());
    }

    if path_contains_omnibase(&new_path) {
        return Err("拒绝：新程序路径位于 OmniDatabase 内，请勿从数据目录选取更新文件".into());
    }

    let current = std::env::current_exe().map_err(|e| format!("无法解析当前程序路径：{e}"))?;
    if same_path(&current, &new_path) {
        return Err("新文件与当前正在运行的程序是同一文件".into());
    }

    let dir = current
        .parent()
        .ok_or_else(|| "当前程序没有父目录".to_string())?;
    if path_contains_omnibase(dir) {
        return Err("拒绝：当前程序位于 OmniDatabase 内，无法安全更新".into());
    }

    let current_name = current
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "OmniPlayer.exe".into());

    // 旁路备份，失败不阻断
    let bak = dir.join("OmniPlayer.exe.bak");
    let _ = fs::copy(&current, &bak);

    let new_staging = dir.join("OmniPlayer.exe.new");
    fs::copy(&new_path, &new_staging).map_err(|e| format!("复制新程序失败：{e}"))?;

    let rec_src = new_path
        .parent()
        .map(|p| p.join("omnitrace_input.exe"))
        .filter(|p| p.is_file());
    let rec_staging = dir.join("omnitrace_input.exe.new");
    let rec_cur = dir.join("omnitrace_input.exe");
    let rec_old = dir.join("omnitrace_input.exe.old");
    let rec_staged = if let Some(src) = rec_src {
        let _ = fs::copy(&rec_cur, dir.join("omnitrace_input.exe.bak"));
        fs::copy(&src, &rec_staging).map_err(|e| format!("复制采集程序失败：{e}"))?;
        true
    } else {
        false
    };

    let old_path = dir.join(format!("{current_name}.old"));
    let bat_path = dir.join("update_omniplayer.bat");
    let rec_block = if rec_staged {
        format!(
            r#"
:waitrec
if exist "{rec_new}" (
  move /Y "{rec_cur}" "{rec_old}" >nul 2>&1
  move /Y "{rec_new}" "{rec_cur}" >nul 2>&1
  if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto waitrec
  )
)
"#,
            rec_new = rec_staging.display(),
            rec_cur = rec_cur.display(),
            rec_old = rec_old.display(),
        )
    } else {
        String::new()
    };
    let bat_body = format!(
        r#"@echo off
chcp 65001 >nul
:wait
timeout /t 1 /nobreak >nul
move /Y "{cur}" "{old}" >nul 2>&1
if errorlevel 1 goto wait
move /Y "{staging}" "{cur}" >nul 2>&1
if errorlevel 1 goto wait
{rec}
start "" "{cur}"
del "%~f0"
"#,
        cur = current.display(),
        old = old_path.display(),
        staging = new_staging.display(),
        rec = rec_block,
    );
    fs::write(&bat_path, bat_body).map_err(|e| format!("写入更新脚本失败：{e}"))?;

    spawn_update_bat(&bat_path)?;
    Ok(UPDATE_MSG.into())
}

#[tauri::command]
pub fn quit_for_update(app: tauri::AppHandle) {
    app.exit(0);
}

fn strip_v(s: &str) -> &str {
    s.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
}

fn parse_semver_triple(s: &str) -> Option<(u64, u64, u64)> {
    let t = strip_v(s);
    let core = t.split('-').next().unwrap_or(t);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    match (parse_semver_triple(latest), parse_semver_triple(current)) {
        (Some(a), Some(b)) => a > b,
        _ => strip_v(latest) != strip_v(current) && !latest.is_empty(),
    }
}

fn is_release_asset_prefix(n: &str) -> bool {
    n.starts_with("omnitrace-") || n.starts_with("liuhen-")
}

fn is_update_zip_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    is_release_asset_prefix(&n) && n.ends_with("-windows-x64-update.zip")
}

fn is_portable_zip_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    is_release_asset_prefix(&n) && n.ends_with("-windows-x64.zip") && !n.contains("-update")
}

fn github_host_allowed(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "github.com"
        || h == "api.github.com"
        || h.ends_with(".githubusercontent.com")
}

fn github_path_allowed(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host.ends_with(".githubusercontent.com") {
        return true;
    }
    let path = url.path().to_ascii_lowercase();
    let owner = GITHUB_OWNER.to_ascii_lowercase();
    let repo = GITHUB_REPO.to_ascii_lowercase();
    let legacy = GITHUB_REPO_LEGACY.to_ascii_lowercase();
    path.starts_with(&format!("/{owner}/{repo}"))
        || path.starts_with(&format!("/repos/{owner}/{repo}"))
        || path.starts_with(&format!("/{owner}/{legacy}"))
        || path.starts_with(&format!("/repos/{owner}/{legacy}"))
}

fn github_url_allowed(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    github_host_allowed(host) && github_path_allowed(url)
}

fn github_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 8 {
            return attempt.error("too many redirects");
        }
        if github_url_allowed(attempt.url()) {
            attempt.follow()
        } else {
            let blocked = format!("blocked redirect host {}", attempt.url());
            attempt.error(blocked)
        }
    })
}

fn github_api_latest_url() -> String {
    format!("https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest")
}

fn github_user_agent() -> String {
    format!(
        "Liuhen/{} (+https://github.com/{}/{})",
        env!("CARGO_PKG_VERSION"),
        GITHUB_OWNER,
        GITHUB_REPO
    )
}

fn build_github_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .user_agent(github_user_agent())
        .timeout(timeout)
        .redirect(github_redirect_policy());
    crate::local_http_proxy::configure_upstream_reqwest(builder)
        .build()
        .map_err(|e| format!("无法建立网络客户端：{e}"))
}

#[derive(Clone)]
struct ChosenAsset {
    name: String,
    url: String,
    size: u64,
}

fn pick_zip_asset(assets: &[serde_json::Value]) -> Option<ChosenAsset> {
    let mut update: Option<ChosenAsset> = None;
    let mut portable: Option<ChosenAsset> = None;
    for a in assets {
        let name = a.get("name")?.as_str()?.trim();
        let url = a.get("browser_download_url")?.as_str()?.trim();
        if name.is_empty() || url.is_empty() {
            continue;
        }
        let parsed = reqwest::Url::parse(url).ok()?;
        if !github_url_allowed(&parsed) {
            continue;
        }
        let size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        let chosen = ChosenAsset {
            name: name.to_string(),
            url: url.to_string(),
            size,
        };
        if is_update_zip_name(name) {
            update = Some(chosen);
        } else if is_portable_zip_name(name) {
            portable = Some(chosen);
        }
    }
    update.or(portable)
}

async fn fetch_latest_release() -> Result<(String, ChosenAsset), String> {
    let api = github_api_latest_url();
    let parsed = reqwest::Url::parse(&api).map_err(|e| format!("内部 URL 无效：{e}"))?;
    if !github_url_allowed(&parsed) {
        return Err("内部 API 地址未通过仓库钉扎校验".into());
    }
    let client = build_github_client(Duration::from_secs(30))?;
    let resp = client
        .get(parsed)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("检查更新失败（网络）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub Release 接口返回 {}。请稍后再试。",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("无法解析 GitHub 响应：{e}"))?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() {
        return Err("GitHub Release 没有 tag".into());
    }
    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let asset = pick_zip_asset(&assets).ok_or_else(|| {
        "此版本没有可增量安装的 zip（需要 Liuhen-*-windows-x64-update.zip 或 .zip；旧版 OmniTrace-* 也可）。首次安装请用浏览器下载 setup.exe。"
            .to_string()
    })?;
    Ok((tag, asset))
}

#[tauri::command]
pub async fn github_check_update() -> Result<GithubUpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let (tag, asset) = fetch_latest_release().await?;
    let latest_version = strip_v(&tag).to_string();
    Ok(GithubUpdateInfo {
        current_version: current.clone(),
        latest_tag: tag.clone(),
        latest_version: latest_version.clone(),
        newer: is_newer_version(&tag, &current),
        asset_name: asset.name,
        asset_size: asset.size,
        incoming: probe_portable_update(),
    })
}

fn dest_name_from_zip_entry(file_name: &str) -> Option<&'static str> {
    if is_omniplayer_exe_name(file_name) {
        Some("OmniPlayer.exe")
    } else if file_name.eq_ignore_ascii_case("omnitrace_input.exe") {
        Some("omnitrace_input.exe")
    } else if file_name.eq_ignore_ascii_case("OmniTrace.ico")
        || file_name.eq_ignore_ascii_case("icon.ico")
    {
        Some("OmniTrace.ico")
    } else {
        None
    }
}

fn zip_entry_safe(name: &str) -> bool {
    let norm = name.replace('\\', "/");
    !norm.split('/').any(|p| {
        p == ".." || p == "." || p.eq_ignore_ascii_case("OmniDatabase") || p.contains(':')
    })
}

fn extract_program_files(zip_path: &Path, incoming: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打不开下载的 zip：{e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("无法打开 zip：{e}"))?;
    let mut found_player = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败：{e}"))?;
        if !entry.is_file() {
            continue;
        }
        let raw_name = entry.name().to_string();
        if !zip_entry_safe(&raw_name) {
            continue;
        }
        let file_name = raw_name
            .replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        let Some(dest_name) = dest_name_from_zip_entry(&file_name) else {
            continue;
        };
        if dest_name == "OmniPlayer.exe" {
            found_player = true;
        }
        let dest = incoming.join(dest_name);
        if path_contains_omnibase(&dest) {
            return Err("拒绝：解压目标位于 OmniDatabase 内".into());
        }
        let mut out =
            fs::File::create(&dest).map_err(|e| format!("写入 {} 失败：{e}", dest.display()))?;
        io::copy(&mut entry, &mut out).map_err(|e| format!("解压 {} 失败：{e}", dest_name))?;
        out.flush().ok();
    }
    if !found_player {
        return Err("压缩包里没有 OmniPlayer.exe".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn github_download_update(app: tauri::AppHandle) -> Result<PendingPortableUpdate, String> {
    let (_tag, asset) = fetch_latest_release().await?;
    let parsed = reqwest::Url::parse(&asset.url).map_err(|e| format!("资源地址无效：{e}"))?;
    if !github_url_allowed(&parsed) || !github_host_allowed(parsed.host_str().unwrap_or("")) {
        return Err("拒绝：下载地址不是 GitHub Release".into());
    }
    if !(is_update_zip_name(&asset.name) || is_portable_zip_name(&asset.name)) {
        return Err("拒绝：只接受 Liuhen / OmniTrace Windows zip，不会下载 setup.exe".into());
    }

    let incoming = incoming_dir()?;
    let zip_path = incoming.join("_github_update.zip");
    let _ = fs::remove_file(&zip_path);

    let client = build_github_client(Duration::from_secs(15 * 60))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("下载失败（网络）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(asset.size);
    let mut file =
        fs::File::create(&zip_path).map_err(|e| format!("无法写入下载文件：{e}"))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("写入下载文件失败：{e}"))?;
        downloaded += bytes.len() as u64;
        let _ = app.emit(
            "github-update-progress",
            UpdateDownloadProgress {
                downloaded,
                total,
                asset_name: asset.name.clone(),
            },
        );
    }
    file.flush().ok();
    drop(file);

    extract_program_files(&zip_path, &incoming)?;
    let _ = fs::remove_file(&zip_path);

    let player = incoming.join("OmniPlayer.exe");
    if !player.is_file() {
        return Err("解压后找不到 incoming\\OmniPlayer.exe".into());
    }
    Ok(PendingPortableUpdate {
        path: player.to_string_lossy().into_owned(),
        source: "incoming".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_newer() {
        assert!(is_newer_version("v0.1.5", "0.1.3"));
        assert!(is_newer_version("0.2.0", "0.1.9"));
        assert!(!is_newer_version("v0.1.3", "0.1.3"));
        assert!(!is_newer_version("0.1.2", "0.1.3"));
    }

    #[test]
    fn zip_name_prefers_update() {
        assert!(is_update_zip_name("OmniTrace-0.1.5-windows-x64-update.zip"));
        assert!(is_update_zip_name("Liuhen-0.1.5-windows-x64-update.zip"));
        assert!(is_portable_zip_name("OmniTrace-0.1.5-windows-x64.zip"));
        assert!(is_portable_zip_name("Liuhen-0.1.5-windows-x64.zip"));
        assert!(!is_portable_zip_name(
            "OmniTrace-0.1.5-windows-x64-update.zip"
        ));
        assert!(!is_update_zip_name(
            "OmniTrace-0.1.5-windows-x64-setup.exe"
        ));
        assert!(!is_portable_zip_name(
            "OmniTrace-0.1.5-windows-x64-setup.exe"
        ));
    }

    #[test]
    fn url_pin_blocks_other_hosts() {
        let ok = reqwest::Url::parse(
            "https://github.com/Fortda/liuhen/releases/download/v0.1.3/x.zip",
        )
        .unwrap();
        assert!(github_url_allowed(&ok));
        let legacy = reqwest::Url::parse(
            "https://github.com/Fortda/omnitrace/releases/download/v0.1.3/x.zip",
        )
        .unwrap();
        assert!(github_url_allowed(&legacy));
        let api =
            reqwest::Url::parse("https://api.github.com/repos/Fortda/liuhen/releases/latest")
                .unwrap();
        assert!(github_url_allowed(&api));
        let other =
            reqwest::Url::parse("https://evil.example/Fortda/omnitrace/releases/download/x.zip")
                .unwrap();
        assert!(!github_url_allowed(&other));
        let other_repo =
            reqwest::Url::parse("https://github.com/other/omnitrace/releases/download/x.zip")
                .unwrap();
        assert!(!github_url_allowed(&other_repo));
    }
}
