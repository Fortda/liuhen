/**
 * Composer 选模型 / 设置页模型开关共用：providers.json 的 disabled_model_keys。
 * 缺省空 = 全开；新发现的模型不在列表里，默认开。
 */
import {
  modelKey,
  type NotesModelRef,
  type NotesProvider,
  type ProvidersFile,
} from "./notes_types";

export const PROVIDERS_CHANGED_EVENT = "omnitrace-providers-changed";

export function disabledKeysOf(pf: ProvidersFile): Set<string> {
  return new Set(pf.disabled_model_keys || []);
}

export function isModelEnabled(pf: ProvidersFile, key: string): boolean {
  return !disabledKeysOf(pf).has(key);
}

export function visiblePickerModels(
  models: NotesModelRef[],
  pf: ProvidersFile
): NotesModelRef[] {
  const hidden = disabledKeysOf(pf);
  if (!hidden.size) return models;
  return models.filter((m) => !hidden.has(modelKey(m.provider_id, m.model_id)));
}

export function providerEnableState(
  p: NotesProvider,
  pf: ProvidersFile
): "all" | "none" | "mixed" {
  if (!p.models.length) return "none";
  let on = 0;
  for (const m of p.models) {
    if (isModelEnabled(pf, modelKey(p.id, m.id))) on += 1;
  }
  if (on === 0) return "none";
  if (on === p.models.length) return "all";
  return "mixed";
}

export function applyProviderEnable(
  pf: ProvidersFile,
  providerId: string,
  enable: boolean
): string[] {
  const p = pf.providers.find((x) => x.id === providerId);
  const disabled = disabledKeysOf(pf);
  if (!p) return [...disabled];
  for (const m of p.models) {
    const k = modelKey(p.id, m.id);
    if (enable) disabled.delete(k);
    else disabled.add(k);
  }
  return [...disabled];
}

export function applyModelEnable(
  pf: ProvidersFile,
  key: string,
  enable: boolean
): string[] {
  const disabled = disabledKeysOf(pf);
  if (enable) disabled.delete(key);
  else disabled.add(key);
  return [...disabled];
}

export function providerIsConfigured(p: NotesProvider): boolean {
  return !!p.api_key.trim();
}

export function realModelSyncFails(pf: ProvidersFile): NotesProvider[] {
  return pf.providers.filter((p) => {
    const err = (p.models_sync_error || "").trim();
    if (!err) return false;
    if (!p.api_key.trim() || err === "未填写 API Key") return false;
    return true;
  });
}

export function notifyProvidersChanged(pf: ProvidersFile) {
  window.dispatchEvent(
    new CustomEvent<ProvidersFile>(PROVIDERS_CHANGED_EVENT, { detail: pf })
  );
}

export function onProvidersChanged(
  fn: (pf: ProvidersFile) => void
): () => void {
  const handler = (e: Event) => {
    const ev = e as CustomEvent<ProvidersFile>;
    if (ev.detail) fn(ev.detail);
  };
  window.addEventListener(PROVIDERS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, handler);
}
