/**
 * 笔记 Composer MCP 小窗：总开关、各 MCP 开关、prefs 落盘（localStorage + Tauri）。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
type McpExtrasSink = (labels: string[]) => void;
let extrasSink: McpExtrasSink | null = null;

/** 由 notes.ts 注入，避免循环依赖。 */
export function bindMcpContextUsageSink(sink: McpExtrasSink) {
  extrasSink = sink;
}

export const MCP_LS_KEY = "omnitrace.notes.mcp_prefs";

export const SERVER_CLUE_BOARD = "clue_board";
export const SERVER_OMNI_DATA = "omni_data";
export const SERVER_OMNI_ARCH = "omni_arch";
export const SERVER_OMNI_DASH_UI = "omni_dash_ui";
export const SERVER_OMNI_SEARCH = "omni_search";
export const SERVER_OMNI_ARTIFACT = "omni_artifact";

export type McpServerToggle = {
  id: string;
  enabled: boolean;
};

export type McpPrefs = {
  v: number;
  inject_product_context: boolean;
  servers: McpServerToggle[];
};

export type SearchConfig = {
  v: number;
  engine: "duckduckgo" | "searx" | "brave" | "custom" | string;
  searx_url: string;
  custom_url: string;
  api_key: string;
};

const SERVER_META: Record<string, { label: string; hint: string }> = {
  [SERVER_CLUE_BOARD]: {
    label: "线索板",
    hint: "读写 clue_boards.json",
  },
  [SERVER_OMNI_DATA]: {
    label: "软件数据",
    hint: "只读 OmniDatabase 摘要",
  },
  [SERVER_OMNI_ARCH]: {
    label: "架构 / ADR",
    hint: "读蓝图；写 ADR 草稿",
  },
  [SERVER_OMNI_DASH_UI]: {
    label: "仪表盘 UI",
    hint: "统计 / 运行状态 / 睡眠页前端",
  },
  [SERVER_OMNI_SEARCH]: {
    label: "搜索",
    hint: "按笔记设置里的引擎查询",
  },
  [SERVER_OMNI_ARTIFACT]: {
    label: "AI 画板",
    hint: "生成 HTML/Markdown，供排版预览",
  },
};

/** 展示名；未知 id 原样返回。 */
export function mcpServerLabel(id: string): string {
  return SERVER_META[id]?.label || id;
}

/** tool 名 → server id（与 Rust notes_mcp::server_id_for_tool 对齐）。 */
export function mcpServerIdForTool(name: string): string | null {
  switch (name) {
    case "read_data_root":
    case "list_recent_cards":
    case "tail_module_health":
      return SERVER_OMNI_DATA;
    case "read_blueprint":
    case "write_adr_draft":
    case "write_arch_suggestion":
      return SERVER_OMNI_ARCH;
    case "read_dash_ui_file":
    case "apply_dash_ui_patch":
      return SERVER_OMNI_DASH_UI;
    case "web_search":
      return SERVER_OMNI_SEARCH;
    case "write_artifact":
      return SERVER_OMNI_ARTIFACT;
    case "clue_board_list":
    case "clue_board_get":
    case "clue_board_create_board":
    case "clue_board_create_note":
    case "clue_board_update_note":
    case "clue_board_delete_note":
    case "clue_board_add_edge":
    case "clue_board_delete_edge":
    case "clue_board_set_active":
      return SERVER_CLUE_BOARD;
    default:
      return null;
  }
}

function defaultServers(): McpServerToggle[] {
  return [
    { id: SERVER_CLUE_BOARD, enabled: false },
    { id: SERVER_OMNI_DATA, enabled: false },
    { id: SERVER_OMNI_ARCH, enabled: false },
    { id: SERVER_OMNI_DASH_UI, enabled: false },
    { id: SERVER_OMNI_SEARCH, enabled: false },
    { id: SERVER_OMNI_ARTIFACT, enabled: false },
  ];
}

export function defaultMcpPrefs(): McpPrefs {
  return {
    v: 1,
    inject_product_context: true,
    servers: defaultServers(),
  };
}

function mergePrefs(raw: Partial<McpPrefs> | null | undefined): McpPrefs {
  const base = defaultMcpPrefs();
  if (!raw) return base;
  const byId = new Map(base.servers.map((s) => [s.id, { ...s }]));
  for (const s of raw.servers || []) {
    if (byId.has(s.id)) {
      byId.set(s.id, { id: s.id, enabled: !!s.enabled });
    }
  }
  return {
    v: 1,
    inject_product_context:
      raw.inject_product_context ?? base.inject_product_context,
    servers: [...byId.values()],
  };
}

let mcpPrefs: McpPrefs = defaultMcpPrefs();
let saveTimer: number | null = null;

export function getMcpPrefs(): McpPrefs {
  return mcpPrefs;
}

export function enabledMcpServerIds(): string[] {
  return mcpPrefs.servers.filter((s) => s.enabled).map((s) => s.id);
}

export function mcpTurnOpts(): {
  inject_product_context: boolean;
  enabled_server_ids: string[];
} {
  return {
    inject_product_context: mcpPrefs.inject_product_context,
    enabled_server_ids: enabledMcpServerIds(),
  };
}

function readLocalMcpPrefs(): McpPrefs | null {
  try {
    const raw = localStorage.getItem(MCP_LS_KEY);
    if (!raw) return null;
    return mergePrefs(JSON.parse(raw) as McpPrefs);
  } catch {
    return null;
  }
}

function writeLocalMcpPrefs(p: McpPrefs) {
  try {
    localStorage.setItem(MCP_LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function syncContextUsageMcpExtras() {
  const names = mcpPrefs.servers
    .filter((s) => s.enabled)
    .map((s) => SERVER_META[s.id]?.label || s.id);
  extrasSink?.(names);
}

function schedulePersist() {
  writeLocalMcpPrefs(mcpPrefs);
  syncContextUsageMcpExtras();
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void invoke<McpPrefs>("notes_mcp_prefs_save", { prefs: mcpPrefs }).catch(
      () => undefined
    );
  }, 280);
}

export function setMcpPrefs(next: McpPrefs) {
  mcpPrefs = mergePrefs(next);
  schedulePersist();
}

export async function loadMcpPrefsFromDisk(): Promise<McpPrefs> {
  const local = readLocalMcpPrefs();
  try {
    const disk = mergePrefs(await invoke<McpPrefs>("notes_mcp_prefs_get"));
    mcpPrefs = local || disk;
    writeLocalMcpPrefs(mcpPrefs);
    syncContextUsageMcpExtras();
    return mcpPrefs;
  } catch {
    mcpPrefs = local || defaultMcpPrefs();
    syncContextUsageMcpExtras();
    return mcpPrefs;
  }
}

export async function getSearchConfig(): Promise<SearchConfig> {
  try {
    return await invoke<SearchConfig>("notes_search_config_get");
  } catch {
    return {
      v: 1,
      engine: "duckduckgo",
      searx_url: "",
      custom_url: "",
      api_key: "",
    };
  }
}

export async function saveSearchConfig(cfg: SearchConfig): Promise<SearchConfig> {
  return invoke<SearchConfig>("notes_search_config_save", { config: cfg });
}

let mcpPopoverOpen = false;
let mcpOutsideHandler: ((e: MouseEvent) => void) | null = null;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function closeMcpPopover() {
  mcpPopoverOpen = false;
  const btn = $("notes-mcp-btn");
  const pop = $("notes-mcp-popover");
  btn?.setAttribute("aria-expanded", "false");
  hideFloat(pop);
  if (mcpOutsideHandler) {
    document.removeEventListener("click", mcpOutsideHandler, true);
    mcpOutsideHandler = null;
  }
}

function renderMcpPopoverContent(host: HTMLElement) {
  host.innerHTML = "";
  const head = document.createElement("div");
  head.className = "notes-mcp-pop-head";
  head.textContent = "MCP 工具";
  host.appendChild(head);

  const master = document.createElement("label");
  master.className = "notes-mcp-row notes-mcp-master";
  master.innerHTML = `
    <input type="checkbox" id="notes-mcp-inject" ${mcpPrefs.inject_product_context ? "checked" : ""} />
    <span>
      <strong>告诉 AI 与本软件有关</strong>
      <small>注入软件上下文，并自动按需启用下方 MCP 权限</small>
    </span>
  `;
  host.appendChild(master);

  const sep = document.createElement("div");
  sep.className = "notes-mcp-sep";
  host.appendChild(sep);

  for (const s of mcpPrefs.servers) {
    const meta = SERVER_META[s.id] || { label: s.id, hint: "" };
    const row = document.createElement("label");
    row.className = "notes-mcp-row";
    row.innerHTML = `
      <input type="checkbox" data-mcp-id="${s.id}" ${s.enabled ? "checked" : ""} />
      <span>
        <strong>${meta.label}</strong>
        <small>${meta.hint}</small>
      </span>
    `;
    host.appendChild(row);
  }

  master.querySelector("input")?.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    setMcpPrefs({ ...mcpPrefs, inject_product_context: checked });
  });

  host.querySelectorAll("[data-mcp-id]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const id = (e.target as HTMLInputElement).dataset.mcpId || "";
      const checked = (e.target as HTMLInputElement).checked;
      const servers = mcpPrefs.servers.map((s) =>
        s.id === id ? { ...s, enabled: checked } : s
      );
      setMcpPrefs({ ...mcpPrefs, servers });
    });
  });
}

function openMcpPopover(anchor: HTMLElement) {
  let pop = $("notes-mcp-popover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "notes-mcp-popover";
    pop.className = "notes-mcp-popover omni-float hidden";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-hidden", "true");
    document.body.appendChild(pop);
  }
  renderMcpPopoverContent(pop);
  revealFloat(pop);
  placeFloatInViewport(pop, anchor.getBoundingClientRect(), "above", 320);
  mcpPopoverOpen = true;
  anchor.setAttribute("aria-expanded", "true");
  if (mcpOutsideHandler) {
    document.removeEventListener("click", mcpOutsideHandler, true);
  }
  mcpOutsideHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.("#notes-mcp-popover") || t?.closest?.("#notes-mcp-btn")) {
      return;
    }
    closeMcpPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", mcpOutsideHandler!, true);
  }, 0);
}

export function initMcpPrefsUi() {
  void loadMcpPrefsFromDisk();
  const btn = $("notes-mcp-btn");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (mcpPopoverOpen) closeMcpPopover();
    else openMcpPopover(btn);
  });
}

export function closeMcpPopoverOnLeave() {
  closeMcpPopover();
}

/** 笔记设置页：搜索引擎表单 */
export function buildSearchSettingsSection(
  cfg: SearchConfig,
  onSaved: (c: SearchConfig) => void
): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "notes-settings-section notes-search-settings";
  wrap.innerHTML = `<h3 class="notes-settings-subhead">搜索引擎（MCP）</h3>
    <p class="notes-settings-hint">供笔记 MCP「搜索」工具使用；密钥只落 OmniDatabase/notes/config/。</p>`;

  const engineRow = document.createElement("label");
  engineRow.className = "notes-settings-field";
  engineRow.innerHTML = `<span>引擎</span>`;
  const engineSel = document.createElement("select");
  engineSel.id = "notes-search-engine";
  for (const [val, label] of [
    ["duckduckgo", "DuckDuckGo（无需密钥）"],
    ["searx", "SearX（自填实例 URL）"],
    ["brave", "Brave Search API"],
    ["custom", "自定义 URL（{q} 占位）"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (cfg.engine === val) opt.selected = true;
    engineSel.appendChild(opt);
  }
  engineRow.appendChild(engineSel);
  wrap.appendChild(engineRow);

  const searxRow = document.createElement("label");
  searxRow.className = "notes-settings-field";
  searxRow.innerHTML = `<span>SearX 实例 URL</span>`;
  const searxInput = document.createElement("input");
  searxInput.type = "url";
  searxInput.placeholder = "https://searx.example.org";
  searxInput.value = cfg.searx_url;
  searxRow.appendChild(searxInput);
  wrap.appendChild(searxRow);

  const customRow = document.createElement("label");
  customRow.className = "notes-settings-field";
  customRow.innerHTML = `<span>自定义 URL</span>`;
  const customInput = document.createElement("input");
  customInput.type="url";
  customInput.placeholder = "https://example.com/search?q={q}";
  customInput.value = cfg.custom_url;
  customRow.appendChild(customInput);
  wrap.appendChild(customRow);

  const keyRow = document.createElement("label");
  keyRow.className = "notes-settings-field";
  keyRow.innerHTML = `<span>API Key（Brave 等）</span>`;
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.value = cfg.api_key;
  keyRow.appendChild(keyInput);
  wrap.appendChild(keyRow);

  const syncVisibility = () => {
    const eng = engineSel.value;
    searxRow.style.display = eng === "searx" ? "" : "none";
    customRow.style.display = eng === "custom" ? "" : "none";
    keyRow.style.display = eng === "brave" ? "" : "none";
  };
  syncVisibility();
  engineSel.addEventListener("change", syncVisibility);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "notes-btn";
  saveBtn.textContent = "保存搜索设置";
  saveBtn.addEventListener("click", () => {
    void saveSearchConfig({
      v: 1,
      engine: engineSel.value,
      searx_url: searxInput.value.trim(),
      custom_url: customInput.value.trim(),
      api_key: keyInput.value.trim(),
    })
      .then(onSaved)
      .catch((e) => {
        console.error(e);
        saveBtn.textContent = "保存失败";
        window.setTimeout(() => {
          saveBtn.textContent = "保存搜索设置";
        }, 1600);
      });
  });
  wrap.appendChild(saveBtn);
  return wrap;
}
