/**
 * 对话存档命名偏好：当时对话的 AI vs 指定总结模型。
 * 设置首页为开关面；连线存档保存对话框读同一 localStorage。
 */
export const ARCHIVE_NAMING_KEY = "omnitrace.notes.archiveNaming.v1";
const LEGACY_AUTO_NOTE_KEY = "omnitrace.notes.autoPresetNote";
export const NONE_MODEL_KEY = "none";

export type ArchiveNamingPrefs = {
  /** true = 用当时对话模型写名字和备注 */
  useConversationAi: boolean;
  /** useConversationAi 为 false（或对话为 NONE）时的总结模型 */
  summarizerModelKey: string;
};

const DEFAULT_PREFS: ArchiveNamingPrefs = {
  useConversationAi: true,
  summarizerModelKey: "",
};

function readLegacyAutoNote(): boolean {
  try {
    const v = localStorage.getItem(LEGACY_AUTO_NOTE_KEY);
    if (v === null) return true;
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

export function getArchiveNamingPrefs(): ArchiveNamingPrefs {
  try {
    const raw = localStorage.getItem(ARCHIVE_NAMING_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ArchiveNamingPrefs>;
      return {
        useConversationAi: p.useConversationAi !== false,
        summarizerModelKey:
          typeof p.summarizerModelKey === "string" ? p.summarizerModelKey : "",
      };
    }
  } catch {
    /* ignore */
  }
  return {
    ...DEFAULT_PREFS,
    useConversationAi: readLegacyAutoNote(),
  };
}

export function setArchiveNamingPrefs(
  patch: Partial<ArchiveNamingPrefs>
): ArchiveNamingPrefs {
  const next: ArchiveNamingPrefs = { ...getArchiveNamingPrefs(), ...patch };
  try {
    localStorage.setItem(ARCHIVE_NAMING_KEY, JSON.stringify(next));
    localStorage.setItem(
      LEGACY_AUTO_NOTE_KEY,
      next.useConversationAi || next.summarizerModelKey ? "1" : "0"
    );
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent("omnitrace-archive-naming", { detail: next })
  );
  return next;
}

export type ArchiveAiPick =
  | { ok: true; modelKey: string; via: "conversation" | "summarizer" }
  | { ok: false; reason: "none" };

export function pickArchiveAiModel(
  conversationModelKey: string | null | undefined
): ArchiveAiPick {
  const prefs = getArchiveNamingPrefs();
  const conv = (conversationModelKey || "").trim();
  const convOk = conv.length > 0 && conv !== NONE_MODEL_KEY;
  if (prefs.useConversationAi && convOk) {
    return { ok: true, modelKey: conv, via: "conversation" };
  }
  const sum = prefs.summarizerModelKey.trim();
  if (sum && sum !== NONE_MODEL_KEY) {
    return { ok: true, modelKey: sum, via: "summarizer" };
  }
  return { ok: false, reason: "none" };
}

function syncArchiveNamingUi() {
  const prefs = getArchiveNamingPrefs();
  const tog = document.getElementById(
    "settings-archive-use-chat-ai"
  ) as HTMLInputElement | null;
  if (tog && document.activeElement !== tog) tog.checked = prefs.useConversationAi;
  const picker = document.getElementById("settings-archive-summarizer-row");
  picker?.classList.toggle("hidden", prefs.useConversationAi);
  const sel = document.getElementById(
    "settings-archive-summarizer"
  ) as HTMLSelectElement | null;
  if (sel && prefs.summarizerModelKey && sel.value !== prefs.summarizerModelKey) {
    sel.value = prefs.summarizerModelKey;
  }
}

async function fillSummarizerSelect() {
  const sel = document.getElementById(
    "settings-archive-summarizer"
  ) as HTMLSelectElement | null;
  if (!sel) return;
  const prefs = getArchiveNamingPrefs();
  try {
    const { listModels } = await import("./notes_llm");
    const { modelKey } = await import("./notes_types");
    const models = await listModels();
    const keep = sel.value;
    sel.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "—";
    sel.appendChild(empty);
    for (const m of models) {
      if (!m.model_id || m.model_id === NONE_MODEL_KEY) continue;
      const opt = document.createElement("option");
      opt.value = modelKey(m.provider_id, m.model_id);
      opt.textContent = `${m.label || m.model_id}`;
      sel.appendChild(opt);
    }
    const want = prefs.summarizerModelKey || keep;
    if (want && [...sel.options].some((o) => o.value === want)) {
      sel.value = want;
    }
  } catch {
    /* sidecar / 未配置 */
  }
}

export function initArchiveNamingSettings() {
  syncArchiveNamingUi();
  document
    .getElementById("settings-archive-use-chat-ai")
    ?.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      setArchiveNamingPrefs({ useConversationAi: on });
      syncArchiveNamingUi();
      if (!on) void fillSummarizerSelect();
    });
  document
    .getElementById("settings-archive-summarizer")
    ?.addEventListener("change", (e) => {
      setArchiveNamingPrefs({
        summarizerModelKey: (e.target as HTMLSelectElement).value,
      });
    });
  window.addEventListener("omnitrace-archive-naming", () => syncArchiveNamingUi());
  window.addEventListener("omnitrace-lang", () => syncArchiveNamingUi());
  if (!getArchiveNamingPrefs().useConversationAi) {
    void fillSummarizerSelect();
  }
}
