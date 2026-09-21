<p align="center">
  <img src="docs/images/icon.png" width="96" height="96" alt="Liuhen">
</p>

<h1 align="center">Liuhen</h1>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-1f6f5b" alt="Chinese README"></a>
  <a href="README.en.md"><img src="https://img.shields.io/badge/README-English-2c2a27" alt="English README"></a>
  <a href="https://github.com/Fortda/liuhen/releases/latest"><img src="https://img.shields.io/github/v/release/Fortda/liuhen?label=download" alt="Download"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6f5b" alt="MIT"></a>
  <a href="https://github.com/Fortda/liuhen"><img src="https://img.shields.io/badge/github-Fortda%2Fliuhen-2c2a27" alt="GitHub"></a>
</p>

**Liuhen** (留痕) is software that helps people record and simulate the world as fully as they can — a form of self-profiling.

This project is the author's **100% AI-oriented programming as a layperson**.

It is a Prajna Plan terminal for intelligence and information capture, and for maintaining a run log of a phenomenal-world model. It aims to extend how far and how finely you can sense the spatiotemporal causal-chain network of the phenomenal world.

Repo: <https://github.com/Fortda/liuhen> · License: [MIT](LICENSE)

By default everything is written under local `OmniDatabase/`. **Nothing is uploaded.** Do not commit API keys, cookies, recordings, or the database.

The Windows shell is still being built and polished. **The Android app is currently almost unusable** (lots of bugs); `omnitrace_android/` is a sketch, not a daily driver. The intent is later **LAN sync with the PC** on your own network — not uploading traces to someone else’s server.

Screenshots sit next to each feature below.

## What it does

- **WinRecorder** (`omnitrace_input.exe`): records mouse, keyboard, which window is focused, and the desktop in the background on Windows. Closing the player window does not stop recording. Use it later to replay “what was on screen then,” and for the dashboard timeline and stats. The switch lives on the Settings page.

  <p align="center"><img src="docs/images/settings.png" alt="Settings: WinRecorder and appearance" width="880"></p>

  Keyboard and mouse recording is already compressed: about 8 hours of intensive PC use a day for a year should stay under about 4 GB, and a heavy day on this machine was about 15 MB; window and other logs are not packed like that yet.

- **Player**: replay a day. Drag the timeline at the bottom. Scroll and zoom can be tuned under Settings → Scroll and zoom; the same page also covers the dashboard and notes timelines. It reconstructs the windows as they were — **not** a video file. Preparing and loading the data is still a bit slow; that needs work.

  <p align="center"><img src="docs/images/player.png" alt="Player: live replay and timeline" width="880"></p>

- **Dashboard**: see which programs you spent time on. Preparing and loading is a bit slow here too. Charts, timelines, and how things look can be kneaded by the in-app assistant with the tools you have checked; a share/install workshop is on the roadmap, not a store you can browse today.

  <p align="center"><img src="docs/images/dashboard-timeline.png" alt="Dashboard: activity timeline" width="880"></p>

  Plus stats charts:

  <p align="center"><img src="docs/images/dashboard-stats.png" alt="Dashboard: stats" width="880"></p>

  Keyboard key frequency:

  <p align="center"><img src="docs/images/dashboard-stats-keys.png" alt="Dashboard: keyboard key frequency" width="880"></p>

  Machine status (network, memory, disk throughput, and so on):

  <p align="center"><img src="docs/images/dashboard-status.png" alt="Dashboard: machine status" width="880"></p>

  And a sleep guess. Data stays on this computer; it is not uploaded to someone else’s server.

  <p align="center"><img src="docs/images/dashboard-sleep.png" alt="Dashboard: sleep guess" width="880"></p>

- **Streaming notes**: chat with an assistant on this machine. The page still needs polish; replies through LiteLLM can hitch. The intent is that charts, timelines, and almost any display effect can be kneaded to taste — via the in-app assistant and allowlisted tools, not a shipped workshop store.

  <p align="center"><img src="docs/images/omniplayer-notes.png" alt="Streaming notes: chat, tool calls, cost, and protocol log" width="880"></p>

  For example:
  - The assistant may only use tools you have checked, such as reading local files you allow (**do not send keyboard logs to a model** — see the warning below)
  - Let the assistant write sticky notes and lines on the clue board, and restore earlier versions
  - Plain chat, with conversation history kept
  - Cost estimates from the model’s list price and actual usage (shown in CNY or USD)
  - A log of requests sent to the model (right side of the shot above)
  - Per-model settings such as thinking depth; providers and keys live under Settings → Language models
  - A timeline of conversation cards

  MCP tool picker:

  <p align="center"><img src="docs/images/notes-mcp.png" alt="Streaming notes: MCP tool picker" width="880"></p>

  Model list and pricing:

  <p align="center"><img src="docs/images/notes-models.png" alt="Streaming notes: model list and pricing" width="880"></p>

  Per-model parameters:

  <p align="center"><img src="docs/images/notes-params.png" alt="Streaming notes: per-model parameters" width="880"></p>

  Notes timeline:

  <p align="center"><img src="docs/images/notes-timeline.png" alt="Notes timeline" width="880"></p>

- **Clue board**: a 2D canvas of sticky notes and lines for ideas, people, and cause-and-effect.

  <p align="center"><img src="docs/images/notes-clue.jpg" alt="Clue board" width="880"></p>

- **Android** (`omnitrace_android/`): a phone trial you install yourself. **Almost unusable today.** The plan is later to talk to the PC on your own local network. It is not in the Windows app yet.

**Keyboard-log warning:** Capture files record real keystrokes. Sending them to any cloud model is sending passwords, DMs, one-time codes, and everything you typed. The in-app assistant must not read the keyboard capture file (`trace_DD.bin`). If you enlarge what tools the assistant can use, make sure it still cannot see keystrokes.

## Architecture

The player starts and stops the recorder. Data lives in `OmniDatabase/`. Notes talk to LiteLLM through a sidecar. Full contracts (currently in Chinese): [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md).

```mermaid
flowchart LR
  OP[OmniPlayer]
  WR[WinRecorder]
  DB[(OmniDatabase)]
  LLM[LiteLLM]
  APK[Android APK]

  OP -->|recorder_ctl| WR
  WR -->|write| DB
  OP -->|playback| DB
  OP -->|"notes sidecar"| LLM
  APK -.->|"planned LAN"| OP
```

## Install (Windows)

For everyday use you do not need a developer toolchain. You need **Windows 10 or 11 (64-bit)**.

1. Open [Releases](https://github.com/Fortda/liuhen/releases/latest)
2. Download **`Liuhen-…-windows-x64-setup.exe`** (player + recorder)
3. Next, Next, Next. Default folder is per-user `%LOCALAPPDATA%\OmniTrace` (no admin prompt in the usual case; on-disk folder name unchanged)
4. Open **Liuhen** (留痕) from the desktop shortcut

Data lives under your user folder `OmniTrace\OmniDatabase`. It is **not uploaded** and is **not** inside the installer. Uninstall (Settings → Apps → Liuhen / 留痕) removes the program only, not that folder.

A **zip** is still attached: unzip and run **安装到本机.bat** (Install on this PC) for the same result.

Windows may say “Windows protected your PC”: **More info → Run anyway** (builds are unsigned). If a double-click does nothing: Properties on the exe → Unblock.

If the Release has no setup.exe yet, that tag has no installer attached. Wait for the next one, or build from source below.

How a maintainer cuts setup.exe / zip and attaches them: [docs/releasing.md](docs/releasing.md).

### From source (development)

The stable copy goes to `%LOCALAPPDATA%\OmniTrace`, with a pointer at the repo `OmniDatabase/`:

```powershell
.\scripts\install-stable.ps1
# or
.\omniplayer\package.ps1 -Install
```

Development: `cd omniplayer && npm run tauri dev`, or `scripts/run-app.bat` at the repo root. The recorder is a detached background process; quitting the window does not stop it.

## Docs

| Doc | Audience |
|-----|----------|
| [README.md](README.md) | Chinese intro |
| [README.en.md](README.en.md) | English intro |
| [CHANGELOG.md](CHANGELOG.md) | What changed in a release |
| [docs/architecture/](docs/architecture/README.md) | How the system is shaped (overview in Chinese) |
| [docs/adr/](docs/adr/README.md) | Why we chose it (ADRs) |
| [docs/releasing.md](docs/releasing.md) | Download notes; how we cut setup.exe / zip |

## Roadmap

Mentioned here only — not implemented yet:

- **Batch import of e-wallet statements** (files stay on disk; not uploaded)
- **Recorder / player module plugin ABI** (paired interfaces: third-party modules write on the capture side and enact an agreed visualization / window architecture in OmniPlayer; the built-in module list is not a hot-load workshop)
- **Dashboard workshop** (share/install interfaces for stats charts and dashboard views — modules, charts, layouts; user traces are not uploaded by default)
- **Phone ↔ PC LAN sync** (the Android capture app is almost unusable today; not a shipping mobile product)

Local-first stays the rule: capture, notes, and any future bill import do not ship the library to someone else's server. A later sharing platform would still not upload `OmniDatabase` by default.

## Contributing

Bugs and ideas: [GitHub Issues](https://github.com/Fortda/liuhen/issues). The in-app Feedback button opens the same place.

Keep `OmniDatabase/`, secrets, recordings, and prompt files on your machine. Screenshot notes: [docs/images/README.md](docs/images/README.md).

## License

[MIT](LICENSE) © 2026 Fortda
