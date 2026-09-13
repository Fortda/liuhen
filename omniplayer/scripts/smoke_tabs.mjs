/**
 * Quick smoke: load preview build, click nav tabs, collect console/page errors.
 * Usage: node scripts/smoke_tabs.mjs [baseUrl]
 */
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4173";
const errors = [];

function defaultInvoke(cmd) {
  if (cmd === "recorder_status") {
    return {
      running: false,
      pid: null,
      instances: 0,
      exe: null,
      repo_root: null,
      autostart: false,
      desired: false,
    };
  }
  if (cmd === "shell_get_launch_info") {
    return { page: null, shell: "full", notesUndocked: false };
  }
  if (cmd === "shell_consume_launch_page") return null;
  if (cmd === "get_data_root") return "OmniDatabase";
  if (cmd === "notes_list_cards") return [];
  if (cmd === "notes_providers_get") {
    return { v: 1, providers: [], default_model_key: null };
  }
  if (cmd === "notes_list_models") return [];
  if (cmd === "notes_wire_presets_get") return { v: 1, presets: [] };
  if (cmd === "notes_clue_board_load") {
    return {
      v: 2,
      active_id: "b1",
      boards: [{ id: "b1", title: "", nodes: [], edges: [], view: null }],
    };
  }
  if (cmd === "dashboard_health_snapshot") return null;
  if (cmd === "dashboard_health") {
    return { now_ts: Date.now(), lanes: [], segments: [] };
  }
  if (cmd === "dashboard_status_charts") {
    return {
      now_ts: Date.now(),
      window_start_ts: Date.now() - 1_800_000,
      recorder_running: false,
      body_samples: 0,
      wan: [],
      cpu: [],
      mem_pct: [],
      power: [],
      input: [],
      focus_rate: [],
      ime_rate: [],
      module_beats: [],
      note: null,
    };
  }
  if (cmd === "list_recordings") return [];
  if (cmd === "player_recorder_spans") return { spans: [] };
  if (cmd === "notes_context_graph_get") return { nodes: [], edges: [] };
  return null;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(() => {
  const mock = (cmd) => {
    if (cmd === "recorder_status") {
      return {
        running: false,
        pid: null,
        instances: 0,
        exe: null,
        repo_root: null,
        autostart: false,
        desired: false,
      };
    }
    if (cmd === "shell_get_launch_info") {
      return { page: null, shell: "full", notesUndocked: false };
    }
    if (cmd === "shell_consume_launch_page") return null;
    if (cmd === "get_data_root") return "OmniDatabase";
    if (cmd === "notes_list_cards") return [];
    if (cmd === "notes_providers_get") {
      return { v: 1, providers: [], default_model_key: null };
    }
    if (cmd === "notes_list_models") return [];
    if (cmd === "notes_wire_presets_get") return { v: 1, presets: [] };
    if (cmd === "notes_clue_board_load") {
      return {
        v: 2,
        active_id: "b1",
        boards: [{ id: "b1", title: "", nodes: [], edges: [], view: null }],
      };
    }
    if (cmd === "dashboard_health_snapshot") return null;
    if (cmd === "dashboard_health") {
      return { now_ts: Date.now(), lanes: [], segments: [] };
    }
    if (cmd === "dashboard_status_charts") {
      return {
        now_ts: Date.now(),
        window_start_ts: Date.now() - 1_800_000,
        recorder_running: false,
        body_samples: 0,
        wan: [],
        cpu: [],
        mem_pct: [],
        power: [],
        input: [],
        focus_rate: [],
        ime_rate: [],
        module_beats: [],
        note: null,
      };
    }
    if (cmd === "list_recordings") return [];
    if (cmd === "player_recorder_spans") return { spans: [] };
    if (cmd === "notes_context_graph_get") return { nodes: [], edges: [] };
    return null;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    invoke: async (cmd) => mock(cmd),
    convertFileSrc: (p) => p,
    transformCallback: () => {},
  };
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(base, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(500);

for (const tab of ["#tab-player", "#tab-dashboard", "#tab-notes", "#tab-settings"]) {
  try {
    await page.click(tab, { timeout: 5000 });
    await page.waitForTimeout(1500);
    const overlay = await page.$eval("#shell-module-loading", (el) =>
      el.classList.contains("is-visible")
    );
    if (overlay) errors.push(`overlay stuck after ${tab}`);
    const active = await page.$eval(tab, (el) => el.classList.contains("active"));
    if (!active) errors.push(`tab not active: ${tab}`);
  } catch (e) {
    errors.push(`click ${tab}: ${e.message}`);
  }
}

await browser.close();
if (errors.length) {
  console.error("SMOKE FAILURES:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("SMOKE OK: no errors, overlay cleared");
