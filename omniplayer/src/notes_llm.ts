import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { McpStreamActivity } from "./notes_mcp_activity";
import type {
  LlmSidecarStatus,
  NotesModelRef,
  ProvidersFile,
  SendTurnStart,
  WireContextInput,
} from "./notes_types";

export type { WireContextInput };

export type NotesProgressEvent = {
  op: string;
  step: string;
  message: string;
  progress: number;
  done: boolean;
  error?: string | null;
};

export async function ensureSidecar(): Promise<LlmSidecarStatus> {
  return invoke<LlmSidecarStatus>("llm_sidecar_ensure_running_cmd");
}

export async function sidecarStatus(): Promise<LlmSidecarStatus> {
  return invoke<LlmSidecarStatus>("llm_sidecar_status_cmd");
}

export async function listModels(): Promise<NotesModelRef[]> {
  return invoke<NotesModelRef[]>("notes_list_models");
}

export async function getProviders(): Promise<ProvidersFile> {
  return invoke<ProvidersFile>("notes_providers_get");
}

export async function saveProviders(
  p: ProvidersFile,
  discoverProviderId?: string | null
): Promise<ProvidersFile> {
  return invoke<ProvidersFile>("notes_providers_save", {
    providers: p,
    discoverProviderId: discoverProviderId ?? null,
  });
}

/** 只更新置顶，不重新拉模型目录 */
export async function setPinnedModelKeys(
  pinnedModelKeys: string[]
): Promise<ProvidersFile> {
  return invoke<ProvidersFile>("notes_providers_set_pinned", {
    pinnedModelKeys,
  });
}

/** 只更新可见开关，不重新拉模型目录 */
export async function setDisabledModelKeys(
  disabledModelKeys: string[]
): Promise<ProvidersFile> {
  return invoke<ProvidersFile>("notes_providers_set_disabled", {
    disabledModelKeys,
  });
}

export async function discoverProviderModels(
  providerId: string
): Promise<ProvidersFile> {
  return invoke<ProvidersFile>("notes_discover_provider_models", {
    providerId,
  });
}

export async function refreshModelsIfStale(
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<ProvidersFile> {
  return invoke<ProvidersFile>("notes_refresh_models_if_stale", {
    maxAgeMs,
  });
}

/** maxAgeMs=0：已配置密钥的服务商一律重拉（Composer「刷新模型」）。 */
export async function refreshModelsNow(): Promise<ProvidersFile> {
  return refreshModelsIfStale(0);
}

export type PriceRates = {
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m?: number | null;
  cache_write_per_1m?: number | null;
  thinking_per_1m?: number | null;
  currency: string;
  doc_url?: string | null;
  updated_at?: string | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
};

export type PricingFile = {
  v: number;
  source?: string;
  source_url?: string | null;
  fetched_at?: string | null;
  fetched_at_ms?: number | null;
  models: Record<string, PriceRates>;
  overrides?: Record<string, PriceRates>;
};

export async function getPricing(): Promise<PricingFile> {
  return invoke<PricingFile>("notes_pricing_get");
}

export async function refreshPricingIfStale(
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<PricingFile> {
  return invoke<PricingFile>("notes_pricing_refresh_if_stale", { maxAgeMs });
}

export async function testConnection(modelKey: string): Promise<string> {
  return invoke<string>("notes_test_connection", { modelKey });
}

export type WirePreset = {
  id: string;
  name: string;
  note: string;
  edges: string[][];
  created_at: number;
  updated_at: number;
};

export type WirePresetsFile = {
  v: number;
  presets: WirePreset[];
};

export async function getWirePresets(): Promise<WirePresetsFile> {
  return invoke<WirePresetsFile>("notes_wire_presets_get");
}

export async function saveWirePresets(file: WirePresetsFile): Promise<WirePresetsFile> {
  return invoke<WirePresetsFile>("notes_wire_presets_save", { file });
}

export async function deleteWirePreset(presetId: string): Promise<WirePresetsFile> {
  return invoke<WirePresetsFile>("notes_wire_presets_delete", { presetId });
}

export type SuggestPresetMeta = { name: string; note: string };

export async function suggestWirePresetNote(
  edges: string[][],
  cards: { id: string; text: string }[],
  modelKey?: string
): Promise<SuggestPresetMeta> {
  return invoke<SuggestPresetMeta>("notes_wire_preset_suggest_note", {
    req: { edges, cards, model_key: modelKey || null },
  });
}

export async function sendTurn(
  userText: string,
  modelKey: string,
  opts?: {
    thinking: boolean;
    thinking_toggle: boolean;
    effort: string;
    thinking_budget?: number | null;
    temperature?: number | null;
    max_tokens?: number | null;
    top_p?: number | null;
    google_search?: boolean;
    wire_context?: WireContextInput | null;
    mcp?: {
      inject_product_context: boolean;
      enabled_server_ids: string[];
      viewing_clue_board?: boolean;
      active_board_id?: string | null;
    } | null;
    image_paths?: string[];
    user_glyphs?: Array<{
      ch: string;
      dt_ms: number;
      deleted?: boolean;
      ts?: number | null;
    }>;
  },
  history?: {
    role: "user" | "assistant";
    content: string;
    created_at?: number;
    card_id?: string;
  }[]
): Promise<SendTurnStart> {
  return invoke<SendTurnStart>("notes_send_turn", {
    userText,
    modelKey,
    opts: opts || null,
    history: history?.length ? history : null,
  });
}

export async function saveUserOnlyCard(
  userText: string,
  imagePaths?: string[],
  userGlyphs?: Array<{
    ch: string;
    dt_ms: number;
    deleted?: boolean;
    ts?: number | null;
  }>
): Promise<SendTurnStart> {
  return invoke<SendTurnStart>("notes_save_user_only_card", {
    userText,
    imagePaths: imagePaths?.length ? imagePaths : null,
    userGlyphs: userGlyphs?.length ? userGlyphs : null,
  });
}

export type McpPrefs = {
  v: number;
  inject_product_context: boolean;
  servers: { id: string; enabled: boolean }[];
};

export type SearchConfig = {
  v: number;
  engine: string;
  searx_url: string;
  custom_url: string;
  api_key: string;
};

export async function getMcpPrefsIpc(): Promise<McpPrefs> {
  return invoke<McpPrefs>("notes_mcp_prefs_get");
}

export async function saveMcpPrefsIpc(prefs: McpPrefs): Promise<McpPrefs> {
  return invoke<McpPrefs>("notes_mcp_prefs_save", { prefs });
}

export async function getSearchConfigIpc(): Promise<SearchConfig> {
  return invoke<SearchConfig>("notes_search_config_get");
}

export async function saveSearchConfigIpc(
  config: SearchConfig
): Promise<SearchConfig> {
  return invoke<SearchConfig>("notes_search_config_save", { config });
}

export type StreamHandlers = {
  onChunk: (payload: {
    card_id: string;
    created_at: number;
    delta: string;
    assistant_text: string;
  }) => void;
  onDone: (payload: {
    card_id: string;
    created_at: number;
    status: string;
    card?: unknown;
  }) => void;
  onError: (payload: { card_id: string; error: string }) => void;
  onStatus?: (payload: {
    card_id: string;
    created_at: number;
    status_text: string;
    activity?: McpStreamActivity | null;
  }) => void;
};

export async function bindStreamHandlers(h: StreamHandlers): Promise<UnlistenFn[]> {
  const u1 = await listen("notes-stream-chunk", (ev) => {
    h.onChunk(ev.payload as Parameters<StreamHandlers["onChunk"]>[0]);
  });
  const u2 = await listen("notes-stream-done", (ev) => {
    h.onDone(ev.payload as Parameters<StreamHandlers["onDone"]>[0]);
  });
  const u3 = await listen("notes-stream-error", (ev) => {
    h.onError(ev.payload as Parameters<StreamHandlers["onError"]>[0]);
  });
  const u4 = await listen("notes-stream-status", (ev) => {
    h.onStatus?.(ev.payload as Parameters<NonNullable<StreamHandlers["onStatus"]>>[0]);
  });
  return [u1, u2, u3, u4];
}

export async function bindProgressHandler(
  onProgress: (p: NotesProgressEvent) => void
): Promise<UnlistenFn> {
  return listen("notes-progress", (ev) => {
    onProgress(ev.payload as NotesProgressEvent);
  });
}
