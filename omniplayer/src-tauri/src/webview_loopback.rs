//! 壳 WebView2：回环与壳 UI 不走系统代理。
//!
//! Clash Verge 开「系统代理」时，WinINET 指向 mixed-port（常见 127.0.0.1:7897）。
//! Chromium/WebView2 **默认仍把 localhost 送进代理**（即使 ProxyOverride 写了 localhost），
//! 结果 Vite/`tauri dev` 的 http://localhost:1420 变成整页 Edge「无法访问此页面 /
//! ERR_CONNECTION_REFUSED」，壳 chrome 全部消失。
//!
//! `--proxy-server=direct://` 只作用于本进程 WebView，不影响系统浏览器。
//! `--proxy-bypass-list=<-loopback>` 是 Chromium 的环回豁免标记。
//!
//! Clash **TUN**（本机 verge.yaml `enable_tun_mode`）走网卡抓包，WebView 直连不够：
//! 需用户把 localhost / 127.0.0.1 放进 Clash skip/bypass。本仓库不改用户 Clash 配置。
//!
//! 与 `tauri.conf.json` 里 `additionalBrowserArgs` 保持同一串（conf 会覆盖 wry 默认，
//! 所以必须自己带上 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`）。

/// 与 `omniplayer/src-tauri/tauri.conf.json` → `app.windows[].additionalBrowserArgs` 同步。
pub const WEBVIEW_ADDITIONAL_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
    "--proxy-server=direct:// ",
    "--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;[::1]"
);

/// 须在创建任何 WebView2 环境之前调用（`Builder::build` 之前）。
pub fn apply_webview_direct_env() {
    #[cfg(windows)]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            WEBVIEW_ADDITIONAL_BROWSER_ARGS,
        );
    }
}
