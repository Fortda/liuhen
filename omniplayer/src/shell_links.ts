/** 公开仓库链接。GitHub 登录名若不是 Fortda，改这里，并改
 *  `src-tauri/tauri.conf.json` 里 updater 的 endpoint，以及
 *  `scripts/write-updater-manifest.mjs` 钉住的下载地址。
 *  默认 Fortda/liuhen。还没有挂 `latest.json` 的 Release 时检查更新会失败，壳照常启动。 */

export const GITHUB_OWNER = "Fortda";
export const GITHUB_REPO = "liuhen";

export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

export const GITHUB_ISSUES_NEW_URL = `${GITHUB_REPO_URL}/issues/new`;

export const GITHUB_RELEASES_LATEST_URL = `${GITHUB_REPO_URL}/releases/latest`;
