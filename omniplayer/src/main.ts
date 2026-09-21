/**
 * 留痕壳：标题栏 / 设置 / 导航 / 关于与反馈（设置子页）。播放器见 ./player.ts，仪表盘见 ./dashboard.ts。
 */
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { initTheme } from "./theme";
import { initMotionStyle } from "./omni_float";
import { initLang, shellT } from "./shell_i18n";
import { GITHUB_ISSUES_NEW_URL, GITHUB_REPO_URL } from "./shell_links";
import { initCostDisplaySettings } from "./notes_cost_display";
import { flushShellApps, initShellApps } from "./shell_apps";
import { initPlaybackSettings } from "./playback_prefs";
import { initArchiveNamingSettings } from "./notes_archive_prefs";

type PlayerMod = typeof import("./player");
type DashboardMod = typeof import("./dashboard");
type NotesMod = typeof import("./notes");

let playerMod: PlayerMod | null = null;
let dashboardMod: DashboardMod | null = null;
let notesMod: NotesMod | null = null;
let playerReady: Promise<PlayerMod> | null = null;
let dashboardReady: Promise<DashboardMod> | null = null;
let notesReady: Promise<NotesMod> | null = null;
/** 由 DOMContentLoaded 赋值，供仪表盘时间轴 seek 回调使用 */
let navigateToPage: (page: string) => void = () => {};

/** URL ?shell=notes → 独立笔记窗；否则完整壳 */
const SHELL_NOTES =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("shell") === "notes";

let notesUndocked = false;
let loadDepth = 0;
let shellAppWin: ReturnType<typeof getCurrentWindow> | null = null;

/** Tauri 未注入 metadata 时 getCurrentWindow 会抛错，壳层须降级而非整页白屏。 */
function resolveShellAppWin(): ReturnType<typeof getCurrentWindow> | null {
  try {
    const meta = (
      window as unknown as {
        __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
      }
    ).__TAURI_INTERNALS__?.metadata;
    if (!meta?.currentWindow?.label) return null;
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function playerWindowApi(): {
  isFullscreen: () => Promise<boolean>;
  setFullscreen: (v: boolean) => Promise<void>;
} {
  if (shellAppWin) return shellAppWin;
  return {
    isFullscreen: async () => false,
    setFullscreen: async () => {},
  };
}

function resetModuleLoadingOverlay() {
  loadDepth = 0;
  const el = document.getElementById("shell-module-loading");
  if (!el) return;
  el.classList.remove("is-visible");
  el.setAttribute("aria-busy", "false");
}

function setModuleLoading(on: boolean, label?: string) {
  const el = document.getElementById("shell-module-loading");
  if (!el) return;
  if (on) loadDepth++;
  else loadDepth = Math.max(0, loadDepth - 1);
  const show = loadDepth > 0;
  el.classList.toggle("is-visible", show);
  el.setAttribute("aria-busy", show ? "true" : "false");
  const lab = el.querySelector(".shell-load-label");
  if (lab && label) lab.textContent = label;
}

async function withModuleLoading<T>(
  label: string,
  work: () => Promise<T>
): Promise<T> {
  setModuleLoading(true, label);
  const guard = window.setTimeout(() => {
    if (loadDepth > 0) {
      console.error(`[shell] module load timeout: ${label}`);
      resetModuleLoadingOverlay();
    }
  }, 120_000);
  try {
    return await work();
  } finally {
    window.clearTimeout(guard);
    setModuleLoading(false);
  }
}

function bindLazyModule<T>(
  slot: "player" | "dashboard" | "notes",
  ready: Promise<T> | null,
  setReady: (p: Promise<T> | null) => void,
  loader: () => Promise<T>
): Promise<T> {
  if (ready) return ready;
  const p = withModuleLoading(
    shellT(`shell.loading.${slot}`) || `加载${slot}…`,
    loader
  ).catch((err) => {
    setReady(null);
    console.error(`[shell] failed to load ${slot} module`, err);
    throw err;
  });
  setReady(p);
  return p;
}

function ensurePlayer(): Promise<PlayerMod> {
  return bindLazyModule("player", playerReady, (p) => {
    playerReady = p;
  }, () =>
    import("./player").then((mod) => {
      mod.initPlayer(playerWindowApi());
      playerMod = mod;
      return mod;
    })
  );
}

function ensureDashboard(): Promise<DashboardMod> {
  return bindLazyModule("dashboard", dashboardReady, (p) => {
    dashboardReady = p;
  }, () =>
    import("./dashboard").then((mod) => {
      mod.initDashboard();
      mod.setTimelineSeekHandler((ts) => {
        navigateToPage("player");
        void ensurePlayer()
          .then((m) => m.seekPlayerToTs(ts))
          .catch((e) => console.error("[shell] seek from dashboard failed", e));
      });
      dashboardMod = mod;
      return mod;
    })
  );
}

function ensureNotes(): Promise<NotesMod> {
  return bindLazyModule("notes", notesReady, (p) => {
    notesReady = p;
  }, () =>
    import("./notes").then((mod) => {
      mod.initNotes();
      notesMod = mod;
      return mod;
    })
  );
}

function activatePageModule(page: string) {
  if (page === "player") {
    void ensurePlayer()
      .then((m) => m.enterPlayerPage())
      .catch((e) => console.error("[shell] enter player failed", e));
  } else if (page === "dashboard") {
    void ensureDashboard()
      .then((m) => {
        const panel =
          (
            document.querySelector(
              "#dash-tabs button.active"
            ) as HTMLElement | null
          )?.dataset.dash || "health";
        m.switchDashPanel(panel);
        m.startDashboardPolling();
      })
      .catch((e) => console.error("[shell] enter dashboard failed", e));
  } else if (page === "notes") {
    void ensureNotes()
      .then((m) => m.enterNotesPage())
      .catch((e) => console.error("[shell] enter notes failed", e));
  }
}

function setNotesUndockedUi(undocked: boolean) {
  notesUndocked = undocked;
  document.body.classList.toggle("is-notes-undocked", undocked && !SHELL_NOTES);
  document
    .getElementById("notes-undocked-placeholder")
    ?.classList.toggle("hidden", !(undocked && !SHELL_NOTES));
}

async function undockNotes() {
  if (SHELL_NOTES) return;
  try {
    if (notesMod) await notesMod.flushNotesPersist();
    notesMod?.leaveNotesPage();
    setNotesUndockedUi(true);
    await invoke("shell_open_notes_window");
  } catch (e) {
    console.error(e);
    setNotesUndockedUi(false);
  }
}

async function redockNotes() {
  try {
    await invoke("shell_close_notes_window");
  } catch (e) {
    console.error(e);
  }
  setNotesUndockedUi(false);
  if (!SHELL_NOTES) {
    navigateToPage("notes");
  }
}

async function focusNotesWindow() {
  try {
    await invoke("shell_open_notes_window");
  } catch (e) {
    console.error(e);
  }
}


/** 回退值；运行时优先用 getVersion()（与 tauri.conf.json 对齐）。 */
let APP_VERSION = "0.1.4";

const UPDATE_LAUNCH_KEY = "omnitrace.update.checkOnLaunch.v1";

type GithubUpdateInfo = {
  current_version: string;
  latest_tag: string;
  latest_version: string;
  newer: boolean;
  asset_name: string;
  asset_size: number;
  incoming: { path: string; source: string } | null;
};

let openAboutSettings: (anchor?: string) => void = () => {};

async function resolveAppVersion(): Promise<string> {
  try {
    const v = await getVersion();
    if (v && typeof v === "string") {
      APP_VERSION = v;
      return v;
    }
  } catch {
    /* browser / 非 Tauri */
  }
  return APP_VERSION;
}

type RecorderStatus = {
  running: boolean;
  pid: number | null;
  instances: number;
  exe: string | null;
  repo_root: string | null;
  autostart: boolean;
  desired?: boolean | null;
};

window.addEventListener("DOMContentLoaded", async () => {
  shellAppWin = resolveShellAppWin();

  const winBtn = (id: string, fn: () => void | Promise<void>) => {
    document.getElementById(id)?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void Promise.resolve(fn()).catch((err) => {
        console.error(`[window:${id}]`, err);
      });
    });
  };
  if (shellAppWin) {
    const appWin = shellAppWin;
    winBtn("btn-min", () => appWin.minimize());
    winBtn("btn-max", () => appWin.toggleMaximize());
    winBtn("btn-close", async () => {
      if (SHELL_NOTES && notesMod) {
        try {
          await notesMod.flushNotesPersist();
        } catch (e) {
          console.error(e);
        }
      }
      try {
        await flushShellApps();
      } catch (e) {
        console.error(e);
      }
      await appWin.close();
    });
  }

  initTheme();
  initMotionStyle();
  initLang();
  initCostDisplaySettings();
  initPlaybackSettings();
  initArchiveNamingSettings();
  initShellDialogs();
  initShellApps(() => ensureNotes());

  const toast = document.getElementById("settings-toast");
  const toggleRecorder = document.getElementById(
    "toggle-recorder"
  ) as HTMLInputElement | null;
  const toggleAutostart = document.getElementById(
    "toggle-autostart"
  ) as HTMLInputElement | null;
  const recorderMeta = document.getElementById("recorder-meta");
  const autostartMeta = document.getElementById("autostart-meta");

  let recorderToggleBusy = false;
  let recorderStatusSynced = false;

  function showSettingsToast(msg: string, ok = false) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.toggle("ok", ok);
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function applyRecorderStatus(s: RecorderStatus) {
    if (toggleRecorder && !recorderToggleBusy) {
      toggleRecorder.checked = !!s.running;
    }
    if (toggleRecorder) {
      toggleRecorder.disabled = recorderToggleBusy;
      toggleRecorder.indeterminate = !recorderStatusSynced;
    }
    if (toggleAutostart) toggleAutostart.checked = !!s.autostart;
    if (recorderMeta) {
      if (s.instances > 1) {
        recorderMeta.textContent = shellT("settings.recorder.meta.multi", {
          n: s.instances,
        });
      } else if (s.running) {
        recorderMeta.textContent = s.pid
          ? shellT("settings.recorder.meta.runningPid", { pid: s.pid })
          : shellT("settings.recorder.meta.running");
      } else if (s.desired === true) {
        recorderMeta.textContent = shellT("settings.recorder.meta.desiredOffSync");
      } else {
        recorderMeta.textContent = shellT("settings.recorder.meta.stopped");
      }
    }
    if (autostartMeta) {
      autostartMeta.textContent = s.autostart
        ? shellT("settings.autostart.meta.on")
        : shellT("settings.autostart.meta.off");
    }
  }

  async function refreshRecorderStatus() {
    try {
      const s = await invoke<RecorderStatus>("recorder_status");
      recorderStatusSynced = true;
      applyRecorderStatus(s);
    } catch (e) {
      recorderStatusSynced = false;
      if (recorderMeta) recorderMeta.textContent = String(e);
      if (toggleRecorder) toggleRecorder.indeterminate = true;
    }
    void refreshOmniSyncMeta();
  }

  function displayFsPath(p: string): string {
    return p.replace(/^\\\\\?\\/, "");
  }

  function dataRootErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (raw.includes("RECORDER_RUNNING")) return shellT("settings.data.err.running");
    if (raw.includes("ENV_OVERRIDE")) return shellT("settings.data.err.env");
    if (raw.includes("NO_EXE_DIR")) return shellT("settings.data.err.exe");
    if (raw.includes("EMPTY_PATH")) return shellT("settings.data.err.empty");
    if (raw.includes("CREATE_DIR")) return shellT("settings.data.err.create");
    if (raw.includes("WRITE_POINTER")) return shellT("settings.data.err.write");
    return raw;
  }

  function setDataRootPathText(text: string) {
    const el = document.getElementById("settings-data-root-path");
    if (el) el.textContent = text;
  }

  async function refreshDataRootPath() {
    setDataRootPathText(shellT("settings.data.meta.loading"));
    try {
      const root = await invoke<string>("get_data_root");
      setDataRootPathText(displayFsPath(root || "—"));
    } catch (e) {
      setDataRootPathText(String(e));
    }
  }

  function notifyDataRootChanged(path: string) {
    window.dispatchEvent(
      new CustomEvent("omnitrace-data-root", { detail: path })
    );
  }

  async function chooseDataRootFolder() {
    const chooseBtn = document.getElementById(
      "settings-data-root-choose"
    ) as HTMLButtonElement | null;
    try {
      const picked = await open({ directory: true, multiple: false });
      const path = typeof picked === "string" ? picked : null;
      if (!path) return;
      if (chooseBtn) chooseBtn.disabled = true;
      const next = await invoke<string>("set_data_root", { path });
      setDataRootPathText(displayFsPath(next || path));
      notifyDataRootChanged(next || path);
      showSettingsToast(shellT("settings.data.toast.changed"), true);
    } catch (e) {
      showSettingsToast(dataRootErrorMessage(e));
    } finally {
      if (chooseBtn) chooseBtn.disabled = false;
    }
  }

  async function openDataRootFolder() {
    try {
      const root = await invoke<string>("get_data_root");
      const path = displayFsPath(root || "");
      if (!path) {
        showSettingsToast(shellT("settings.data.err.open"));
        return;
      }
      await openPath(path);
    } catch (e) {
      showSettingsToast(shellT("settings.data.err.open"));
      console.error(e);
    }
  }

  async function refreshOmniSyncMeta() {
    const el = document.getElementById("omni-sync-meta");
    if (!el) return;
    try {
      const s = await invoke<{ port: number; ips: string[]; hint: string }>("omni_sync_status");
      el.textContent = s.hint || (s.port ? `端口 ${s.port}` : "未绑定");
    } catch (e) {
      el.textContent = String(e);
    }
  }

  async function setRecorderRunning(want: boolean) {
    if (!toggleRecorder) return;
    recorderToggleBusy = true;
    toggleRecorder.disabled = true;
    try {
      const s = await invoke<RecorderStatus>("recorder_set_running", {
        enabled: want,
      });
      applyRecorderStatus(s);
      showSettingsToast(
        want ? shellT("toast.recorder.start") : shellT("toast.recorder.stop"),
        true
      );
    } catch (e) {
      toggleRecorder.checked = !want;
      showSettingsToast(String(e));
      void refreshRecorderStatus();
    } finally {
      recorderToggleBusy = false;
      if (toggleRecorder) toggleRecorder.disabled = false;
    }
  }

  function moveNavPill(activeBtn?: HTMLElement | null) {
    const pill = document.getElementById("nav-pill");
    const tabs = document.getElementById("nav-tabs");
    const btn =
      activeBtn ??
      (document.querySelector(
        "#nav-tabs button.active"
      ) as HTMLElement | null);
    if (!pill || !tabs || !btn) return;
    const tabsRect = tabs.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const x = Math.round(btnRect.left - tabsRect.left);
    const y = Math.round(btnRect.top - tabsRect.top);
    pill.style.width = `${Math.round(btnRect.width)}px`;
    pill.style.height = `${Math.round(btnRect.height)}px`;
    pill.style.transform = `translate(${x}px, ${y}px)`;
  }

  let pageActivateGen = 0;
  type SettingsPane = "home" | "llm" | "playback" | "about";
  let settingsPane: SettingsPane = "home";

  function syncLlmBackLabel() {
    const back = document.getElementById("settings-llm-back");
    if (!back) return;
    back.textContent = shellT(
      SHELL_NOTES ? "settings.llm.backNotes" : "settings.llm.back"
    );
  }

  function setSettingsPane(
    pane: SettingsPane,
    opts?: { skipMount?: boolean }
  ) {
    settingsPane = pane;
    document
      .getElementById("settings-home")
      ?.classList.toggle("hidden", pane !== "home");
    document
      .getElementById("settings-llm")
      ?.classList.toggle("hidden", pane !== "llm");
    document
      .getElementById("settings-playback")
      ?.classList.toggle("hidden", pane !== "playback");
    document
      .getElementById("settings-about")
      ?.classList.toggle("hidden", pane !== "about");
    document
      .getElementById("settings-open-llm")
      ?.setAttribute("aria-expanded", pane === "llm" ? "true" : "false");
    document
      .getElementById("settings-open-playback")
      ?.setAttribute("aria-expanded", pane === "playback" ? "true" : "false");
    document
      .getElementById("settings-open-about")
      ?.setAttribute("aria-expanded", pane === "about" ? "true" : "false");
    syncLlmBackLabel();
    if (pane === "llm" && !opts?.skipMount) {
      void ensureNotes()
        .then((m) => m.mountLlmSettings())
        .catch((e) => console.error("[shell] mount llm settings failed", e));
    }
  }

  function openLlmSettings() {
    if (SHELL_NOTES) document.body.classList.add("shell-notes-llm");
    switchPage("settings", { settingsPane: "llm" });
  }

  function closeLlmSettings() {
    if (SHELL_NOTES) {
      document.body.classList.remove("shell-notes-llm");
      switchPage("notes");
      return;
    }
    setSettingsPane("home");
  }

  function switchPage(
    page: string,
    opts?: { settingsPane?: SettingsPane }
  ) {
    if (page !== "settings") {
      document.body.classList.remove("shell-notes-llm");
      setSettingsPane("home", { skipMount: true });
    } else {
      setSettingsPane(opts?.settingsPane ?? "home");
    }
    // 笔记已摘出时：主窗 notes 页只显示占位，不加载编辑器（XOR）
    if (page === "notes" && notesUndocked && !SHELL_NOTES) {
      let activeBtn: HTMLElement | null = null;
      document.querySelectorAll("#nav-tabs button[data-page]").forEach((b) => {
        const el = b as HTMLElement;
        const on = el.dataset.page === page;
        el.classList.toggle("active", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
        if (on) activeBtn = el;
      });
      document.querySelectorAll(".page").forEach((p) => {
        p.classList.toggle("active", p.id === `page-${page}`);
      });
      moveNavPill(activeBtn);
      setNotesUndockedUi(true);
      queueMicrotask(() => {
        playerMod?.leavePlayerPage();
        dashboardMod?.stopDashboardPolling();
        notesMod?.leaveNotesPage();
      });
      return;
    }

    // 1) 先改 DOM 显隐，再跑离开页/清理（避免扫盘挡住首帧）
    let activeBtn: HTMLElement | null = null;
    document.querySelectorAll("#nav-tabs button[data-page]").forEach((b) => {
      const el = b as HTMLElement;
      const on = el.dataset.page === page;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      if (on) activeBtn = el;
    });
    document.querySelectorAll(".page").forEach((p) => {
      p.classList.toggle("active", p.id === `page-${page}`);
    });
    moveNavPill(activeBtn);

    queueMicrotask(() => {
      if (page !== "player") playerMod?.leavePlayerPage();
      if (page !== "dashboard") dashboardMod?.stopDashboardPolling();
      if (page !== "notes") notesMod?.leaveNotesPage();
    });

    const targetPage = page;
    const gen = ++pageActivateGen;
    requestAnimationFrame(() => {
      if (gen !== pageActivateGen) return;
      if (targetPage === "settings") {
        void refreshRecorderStatus();
        void refreshDataRootPath();
        return;
      }
      activatePageModule(targetPage);
    });
  }

  document.getElementById("settings-open-llm")?.addEventListener("click", () => {
    openLlmSettings();
  });
  document.getElementById("settings-llm-back")?.addEventListener("click", () => {
    closeLlmSettings();
  });
  document.getElementById("settings-open-playback")?.addEventListener("click", () => {
    if (SHELL_NOTES) document.body.classList.add("shell-notes-llm");
    switchPage("settings", { settingsPane: "playback" });
  });
  document.getElementById("settings-playback-back")?.addEventListener("click", () => {
    closeLlmSettings();
  });
  document.getElementById("settings-open-about")?.addEventListener("click", () => {
    if (SHELL_NOTES) document.body.classList.add("shell-notes-llm");
    switchPage("settings", { settingsPane: "about" });
  });
  document.getElementById("settings-about-back")?.addEventListener("click", () => {
    closeLlmSettings();
  });
  openAboutSettings = (anchor) => {
    if (SHELL_NOTES) document.body.classList.add("shell-notes-llm");
    switchPage("settings", { settingsPane: "about" });
    if (anchor) {
      window.setTimeout(() => scrollCaliberAnchor(anchor), 80);
    }
  };
  window.addEventListener("omnitrace-open-llm-settings", () => {
    openLlmSettings();
  });

  const updateMeta = document.getElementById("settings-update-meta");
  const updateCheckBtn = document.getElementById(
    "settings-update-check"
  ) as HTMLButtonElement | null;
  const updateApplyBtn = document.getElementById(
    "settings-update-apply"
  ) as HTMLButtonElement | null;
  const updateLaunchToggle = document.getElementById(
    "toggle-update-launch"
  ) as HTMLInputElement | null;
  let lastUpdateInfo: GithubUpdateInfo | null = null;
  let updateBusy = false;

  function readLaunchCheck(): boolean {
    try {
      const raw = localStorage.getItem(UPDATE_LAUNCH_KEY);
      if (raw === "0") return false;
      if (raw === "1") return true;
    } catch {
      /* private mode */
    }
    return true;
  }

  function writeLaunchCheck(on: boolean) {
    try {
      localStorage.setItem(UPDATE_LAUNCH_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function setUpdateBusy(on: boolean) {
    updateBusy = on;
    if (updateCheckBtn) updateCheckBtn.disabled = on;
    if (updateApplyBtn) updateApplyBtn.disabled = on;
  }

  function showApplyButton(show: boolean) {
    updateApplyBtn?.classList.toggle("hidden", !show);
  }

  function renderUpdateMeta(info: GithubUpdateInfo | null, extra?: string) {
    if (!updateMeta) return;
    if (extra) {
      updateMeta.textContent = extra;
      return;
    }
    if (!info) {
      updateMeta.textContent = shellT("settings.update.meta.idle", {
        version: APP_VERSION,
      });
      return;
    }
    if (info.newer) {
      updateMeta.textContent = shellT("settings.update.available", {
        latest: info.latest_version,
        current: info.current_version,
      });
      return;
    }
    if (info.incoming) {
      updateMeta.textContent = shellT("settings.update.incoming");
      return;
    }
    updateMeta.textContent = shellT("settings.update.uptodate", {
      version: info.current_version,
    });
  }

  async function checkGithubUpdate(opts?: { quiet?: boolean }) {
    if (updateBusy) return;
    setUpdateBusy(true);
    if (!opts?.quiet) {
      renderUpdateMeta(null, shellT("settings.update.checking"));
    }
    try {
      const info = await invoke<GithubUpdateInfo>("github_check_update");
      lastUpdateInfo = info;
      if (info.current_version) APP_VERSION = info.current_version;
      const canApply = info.newer || !!info.incoming;
      showApplyButton(canApply);
      renderUpdateMeta(info);
      if (opts?.quiet) {
        if (info.newer) {
          showSettingsToast(
            shellT("settings.update.launchNewer", {
              latest: info.latest_version,
            }),
            true
          );
        }
        return;
      }
      if (!canApply) {
        showSettingsToast(
          shellT("settings.update.uptodate", { version: info.current_version }),
          true
        );
      }
    } catch (err) {
      lastUpdateInfo = null;
      showApplyButton(false);
      const msg = err instanceof Error ? err.message : String(err);
      try {
        const incoming = await invoke<{ path: string; source: string } | null>(
          "probe_portable_update"
        );
        if (incoming) {
          lastUpdateInfo = {
            current_version: APP_VERSION,
            latest_tag: "",
            latest_version: "",
            newer: false,
            asset_name: "",
            asset_size: 0,
            incoming,
          };
          showApplyButton(true);
          renderUpdateMeta(lastUpdateInfo);
          if (!opts?.quiet) {
            showSettingsToast(shellT("settings.update.incoming"), true);
          }
          return;
        }
      } catch {
        /* ignore probe */
      }
      renderUpdateMeta(null, msg || shellT("settings.update.err.network"));
      if (!opts?.quiet) {
        showSettingsToast(msg || shellT("settings.update.err.network"));
      }
    } finally {
      setUpdateBusy(false);
    }
  }

  async function applyGithubOrIncoming() {
    if (updateBusy) return;
    const info = lastUpdateInfo;
    const fromGithub = !!info?.newer;
    const incomingPath = info?.incoming?.path;
    if (!fromGithub && !incomingPath) {
      await checkGithubUpdate();
      return;
    }
    const ok = window.confirm(
      shellT(
        fromGithub
          ? "settings.update.confirm"
          : "settings.update.confirmIncoming"
      )
    );
    if (!ok) return;
    setUpdateBusy(true);
    try {
      let exePath = incomingPath ?? "";
      if (fromGithub) {
        renderUpdateMeta(info, shellT("settings.update.downloading", {
          name: info?.asset_name || "update.zip",
          pct: 0,
        }));
        const pending = await invoke<{ path: string; source: string }>(
          "github_download_update"
        );
        exePath = pending.path;
      }
      renderUpdateMeta(info, shellT("settings.update.applying"));
      const msg = await invoke<string>("apply_portable_update", {
        newExePath: exePath,
      });
      showSettingsToast(msg || shellT("settings.update.relaunch"), true);
      renderUpdateMeta(info, shellT("settings.update.relaunch"));
      window.setTimeout(() => {
        void invoke("quit_for_update").catch(() => {
          void resolveShellAppWin()?.close();
        });
      }, 400);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderUpdateMeta(info, msg || shellT("settings.update.err.download"));
      showSettingsToast(msg || shellT("settings.update.err.download"));
      setUpdateBusy(false);
    }
  }

  if (updateLaunchToggle) {
    updateLaunchToggle.checked = readLaunchCheck();
    updateLaunchToggle.addEventListener("change", () => {
      writeLaunchCheck(updateLaunchToggle.checked);
    });
  }
  updateCheckBtn?.addEventListener("click", () => {
    void checkGithubUpdate();
  });
  updateApplyBtn?.addEventListener("click", () => {
    void applyGithubOrIncoming();
  });
  void listen<{
    downloaded: number;
    total: number;
    asset_name: string;
  }>("github-update-progress", (ev) => {
    const { downloaded, total, asset_name } = ev.payload;
    const pct =
      total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
    renderUpdateMeta(
      lastUpdateInfo,
      shellT("settings.update.downloading", {
        name: asset_name || "update.zip",
        pct,
      })
    );
  }).catch(() => {
    /* 非 Tauri */
  });
  renderUpdateMeta(null);
  void resolveAppVersion().then(() => {
    if (!lastUpdateInfo) renderUpdateMeta(null);
  });
  window.addEventListener("omnitrace-lang", () => {
    renderUpdateMeta(lastUpdateInfo);
  });
  if (!SHELL_NOTES && readLaunchCheck()) {
    window.setTimeout(() => {
      void checkGithubUpdate({ quiet: true });
    }, 1800);
  }

  document.getElementById("notes-undock-btn")?.addEventListener("click", () => {
    void undockNotes();
  });
  document.getElementById("notes-dock-btn")?.addEventListener("click", () => {
    void (async () => {
      if (SHELL_NOTES && notesMod) await notesMod.flushNotesPersist();
      await redockNotes();
      if (SHELL_NOTES) {
        try {
          await invoke("shell_focus_main_window");
        } catch {
          /* ignore */
        }
        // 独立窗关闭后主窗会收到 notes-dock-changed
      }
    })();
  });
  document
    .getElementById("notes-undocked-focus")
    ?.addEventListener("click", () => {
      void focusNotesWindow();
    });
  document
    .getElementById("notes-undocked-redock")
    ?.addEventListener("click", () => {
      void redockNotes();
    });

  void listen<{ undocked?: boolean }>("notes-dock-changed", (ev) => {
    const undocked = !!ev.payload?.undocked;
    setNotesUndockedUi(undocked);
    if (!SHELL_NOTES && !undocked) {
      const notesActive = document
        .getElementById("page-notes")
        ?.classList.contains("active");
      if (notesActive) {
        void ensureNotes().then((m) => m.enterNotesPage());
      }
    }
  });

  void listen<{ page?: string | null }>("shell-second-instance", (ev) => {
    const page = ev.payload?.page;
    if (!page || SHELL_NOTES) return;
    if (page === "notes") {
      // 已由 Rust 打开/前置笔记窗；主窗显示占位
      setNotesUndockedUi(true);
      switchPage("notes");
      return;
    }
    switchPage(page);
  });

  const navTabButtons = Array.from(
    document.querySelectorAll<HTMLElement>("#nav-tabs button[data-page]")
  );

  navTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (!page) return;
      switchPage(page);
    });
    btn.addEventListener("keydown", (e) => {
      const idx = navTabButtons.indexOf(btn);
      if (idx < 0) return;
      let next = -1;
      if (e.key === "ArrowRight") next = (idx + 1) % navTabButtons.length;
      else if (e.key === "ArrowLeft")
        next = (idx - 1 + navTabButtons.length) % navTabButtons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = navTabButtons.length - 1;
      if (next < 0) return;
      e.preventDefault();
      const target = navTabButtons[next];
      target.focus();
      const page = target.dataset.page;
      if (page) switchPage(page);
    });
  });
  moveNavPill();
  window.addEventListener("resize", () => moveNavPill());
  window.addEventListener("omnitrace-lang", () => {
    requestAnimationFrame(() => {
      moveNavPill();
      requestAnimationFrame(() => moveNavPill());
    });
    void refreshRecorderStatus();
    void refreshDataRootPath();
    if (settingsPane === "llm") syncLlmBackLabel();
  });

  toggleRecorder?.addEventListener("change", () => {
    if (!toggleRecorder || recorderToggleBusy || !recorderStatusSynced) return;
    void setRecorderRunning(toggleRecorder.checked);
  });

  toggleAutostart?.addEventListener("change", async () => {
    if (!toggleAutostart) return;
    const want = toggleAutostart.checked;
    toggleAutostart.disabled = true;
    try {
      const s = await invoke<RecorderStatus>("autostart_set", {
        enabled: want,
      });
      applyRecorderStatus(s);
      showSettingsToast(
        want ? shellT("toast.autostart.on") : shellT("toast.autostart.off"),
        true
      );
    } catch (e) {
      toggleAutostart.checked = !want;
      showSettingsToast(String(e));
    } finally {
      toggleAutostart.disabled = false;
    }
  });

  document
    .getElementById("settings-data-root-choose")
    ?.addEventListener("click", () => {
      void chooseDataRootFolder();
    });
  document
    .getElementById("settings-data-root-open")
    ?.addEventListener("click", () => {
      void openDataRootFolder();
    });
  void refreshDataRootPath();

  navigateToPage = switchPage;

  if (SHELL_NOTES) {
    document.body.classList.add("shell-notes");
    document.title = "留痕 · Notes";
    setNotesUndockedUi(false);
    if (shellAppWin) {
      const appWin = shellAppWin;
      void appWin.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          if (notesMod) await notesMod.flushNotesPersist();
          else if (notesReady) {
            const m = await notesReady;
            await m.flushNotesPersist();
          }
        } catch (e) {
          console.error(e);
        }
        await appWin.destroy();
      });
    }
    switchPage("notes");
    // recorder poll after first paint; notes shell does not need it for UI
    void refreshRecorderStatus();
    window.setInterval(() => {
      if (!recorderToggleBusy) void refreshRecorderStatus();
    }, 5000);
    return;
  }

  // 启动页：CLI --page= / 第二次实例转发；默认设置
  let startPage = "settings";
  try {
    const info = await invoke<{
      page?: string | null;
      shell?: string;
      notesUndocked?: boolean;
    }>("shell_get_launch_info");
    if (info.notesUndocked) setNotesUndockedUi(true);
    const consumed = await invoke<string | null>("shell_consume_launch_page");
    if (consumed) startPage = consumed;
    else if (info.page) startPage = info.page;
  } catch {
    /* 非 Tauri 或旧后端 */
  }
  if (
    startPage !== "settings" &&
    startPage !== "player" &&
    startPage !== "dashboard" &&
    startPage !== "notes"
  ) {
    startPage = "settings";
  }
  // --page=notes：Rust 已开笔记窗时主窗显示占位；否则嵌主窗
  if (startPage === "notes" && notesUndocked) {
    switchPage("notes");
  } else {
    switchPage(startPage);
  }

  // Status poll after first paint so it cannot stall launch IPC.
  void refreshRecorderStatus();
  window.setInterval(() => {
    if (recorderToggleBusy) return;
    const settingsActive = document
      .getElementById("page-settings")
      ?.classList.contains("active");
    if (!settingsActive) return;
    void refreshRecorderStatus();
  }, 2000);
});

function expandCaliberSection(): void {
  const body = document.getElementById("about-caliber-content");
  const toggle = document.querySelector<HTMLButtonElement>(
    "#about-caliber .caliber-section-toggle"
  );
  if (!body || !toggle) return;
  body.classList.remove("is-collapsed");
  toggle.setAttribute("aria-expanded", "true");
  toggle.querySelector(".caliber-block-chevron")?.classList.add("is-open");
}

function expandCaliberBlock(id: string): void {
  const block = document.getElementById(id);
  if (!block?.classList.contains("caliber-block")) return;
  const body = block.querySelector(".caliber-block-body");
  const toggle = block.querySelector<HTMLButtonElement>(".caliber-block-toggle");
  if (!body || !toggle) return;
  body.classList.remove("is-collapsed");
  toggle.setAttribute("aria-expanded", "true");
  toggle.querySelector(".caliber-block-chevron")?.classList.add("is-open");
}

function scrollCaliberAnchor(id: string): void {
  expandCaliberSection();
  expandCaliberBlock(id);
  document.getElementById(id)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function initAboutCaliberCollapses(): void {
  const sectionToggle = document.querySelector<HTMLButtonElement>(
    "#about-caliber .caliber-section-toggle"
  );
  const sectionBody = document.getElementById("about-caliber-content");
  if (sectionToggle && sectionBody) {
    sectionToggle.addEventListener("click", () => {
      const nowCollapsed = !sectionBody.classList.contains("is-collapsed");
      sectionBody.classList.toggle("is-collapsed", nowCollapsed);
      sectionToggle.setAttribute(
        "aria-expanded",
        nowCollapsed ? "false" : "true"
      );
      sectionToggle
        .querySelector(".caliber-block-chevron")
        ?.classList.toggle("is-open", !nowCollapsed);
    });
  }

  document
    .querySelectorAll("#about-caliber .caliber-block")
    .forEach((block) => {
      const toggle = block.querySelector<HTMLButtonElement>(
        ".caliber-block-toggle"
      );
      const body = block.querySelector(".caliber-block-body");
      if (!toggle || !body) return;
      toggle.addEventListener("click", () => {
        const nowCollapsed = !body.classList.contains("is-collapsed");
        body.classList.toggle("is-collapsed", nowCollapsed);
        toggle.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
        toggle
          .querySelector(".caliber-block-chevron")
          ?.classList.toggle("is-open", !nowCollapsed);
      });
    });
}

function initShellDialogs() {
  const versionEls = document.querySelectorAll("[data-app-version]");
  void resolveAppVersion().then((v) => {
    versionEls.forEach((el) => {
      el.textContent = v;
    });
  });

  document.addEventListener("omni:open-about", (ev) => {
    const anchor = (ev as CustomEvent<{ anchor?: string }>).detail?.anchor;
    openAboutSettings(anchor);
  });

  initAboutCaliberCollapses();

  document.querySelectorAll("#about-caliber .caliber-toc a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = (a as HTMLAnchorElement).hash.replace(/^#/, "");
      if (!id) return;
      scrollCaliberAnchor(id);
    });
  });

  async function openExternal(url: string, failKey: string) {
    try {
      await openUrl(url);
    } catch (err) {
      window.alert(
        `${shellT(failKey)}\n${url}\n${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  document.getElementById("btn-about-repo")?.addEventListener("click", (e) => {
    e.preventDefault();
    void openExternal(GITHUB_REPO_URL, "dlg.feedback.issueFail");
  });
  document.getElementById("btn-feedback-issue")?.addEventListener("click", (e) => {
    e.preventDefault();
    void openExternal(GITHUB_ISSUES_NEW_URL, "dlg.feedback.issueFail");
  });

  const copyBtn = document.getElementById("btn-copy-feedback");
  const copyStatus = document.getElementById("feedback-copy-status");
  copyBtn?.addEventListener("click", async () => {
    const ta = document.getElementById(
      "feedback-text"
    ) as HTMLTextAreaElement | null;
    const raw = (ta?.value || "").trim();
    if (!raw) {
      if (copyStatus) copyStatus.textContent = shellT("feedback.copyEmpty");
      return;
    }
    const body = [
      shellT("feedback.copyHeader"),
      `${shellT("feedback.copyVersionLabel")} ${APP_VERSION}`,
      "---",
      raw,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(body);
      if (copyStatus) copyStatus.textContent = shellT("feedback.copyOk");
    } catch {
      if (ta) {
        ta.focus();
        ta.select();
      }
      if (copyStatus) {
        copyStatus.textContent = shellT("feedback.copyFail");
      }
    }
  });
}
