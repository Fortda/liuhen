# Images

Assets for the public README. Keep this folder **privacy-safe**.

| File | Status |
|------|--------|
| `icon.png` | App icon (copied from `omniplayer/src-tauri/icons/icon.png`) |
| `omniplayer-chrome.svg` | Four-tab OmniPlayer **schematic** (cream paper). Not a screenshot. Tabs already loop inside this file; GitHub README `<img>` often shows the first frame only. |
| `omniplayer-tabs.svg` | Tiny looping tab-pill (optional extra). **Schematic, not a product demo GIF.** README uses the chrome SVG only. |

Real UI captures are not in git yet. When you have an empty / dummy workspace, add:

- `settings.png` — settings home (recorder toggle, appearance). No API hosts, keys, or provider lists with secrets.
- `player.png` — player with a blank or synthetic stage. No personal window titles if they identify you.
- `dashboard.png` — dashboard charts on empty or synthetic data.
- `notes.png` — notes page with a throwaway thread. **No personal clue boards.**

Until those exist, READMEs should keep saying “coming when captured” rather than inventing PNGs.

## How to capture later

1. Use a throwaway data root (or a fresh install). Do **not** photograph `OmniDatabase/` from daily use.
2. Clear or dummy-out model providers so API hosts and keys are not on screen.
3. Open Notes on an empty board / empty chat. Do not capture conversation screenshots from this editor — they often contain keys and private boards.
4. Crop to the OmniPlayer window. Light theme is fine; it matches the schematic.
5. Prefer PNG. Keep files small (roughly under 500 KB each).
6. Do not commit recordings, cookies, or database files alongside the screenshots.
