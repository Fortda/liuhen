/** 公开仓库链接。GitHub 登录名若不是 Fortda，只改这里（Rust `portable_update.rs` 须同步钉扎）。
 *  默认 Fortda/liuhen。仓库尚未 `gh repo rename` 时检查更新会 404。 */

export const GITHUB_OWNER = "Fortda";
export const GITHUB_REPO = "liuhen";

export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

export const GITHUB_ISSUES_NEW_URL = `${GITHUB_REPO_URL}/issues/new`;

export const GITHUB_RELEASES_LATEST_URL = `${GITHUB_REPO_URL}/releases/latest`;
