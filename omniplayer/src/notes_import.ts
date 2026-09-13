/**
 * AI Studio / Gemini JSON 导出导入（笔记设置）。
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type AistudioImportResult = {
  imported: number;
  skipped: number;
  report_path: string;
  errors: string[];
};

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function showImportAlert(text: string, kind: "error" | "ok" = "ok") {
  const el = $("notes-settings-alert");
  if (!el) return;
  const msg = text.trim();
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("is-ok", kind === "ok");
  el.textContent = msg;
}

export async function importAistudioExportFiles(): Promise<AistudioImportResult | null> {
  const selected = await open({
    multiple: true,
    filters: [{ name: "JSON", extensions: ["json"] }],
    title: "导入 AI Studio / Gemini 导出",
  });
  if (!selected) return null;
  const paths = (Array.isArray(selected) ? selected : [selected]).filter(
    (p): p is string => typeof p === "string" && !!p
  );
  if (!paths.length) return null;

  showImportAlert("正在导入…", "ok");
  const result = await invoke<AistudioImportResult>("notes_import_aistudio_export", {
    paths,
  });
  const errTail =
    result.errors.length > 0
      ? `\n问题 ${result.errors.length} 条：${result.errors[0]}${
          result.errors.length > 1 ? "…" : ""
        }`
      : "";
  showImportAlert(
    `导入完成：${result.imported} 条，跳过 ${result.skipped}。报告：${result.report_path}${errTail}`,
    result.imported > 0 || result.errors.length === 0 ? "ok" : "error"
  );
  return result;
}

export function initNotesAistudioImport(opts?: {
  onImported?: (result: AistudioImportResult) => void;
}) {
  $("notes-import-aistudio")?.addEventListener("click", () => {
    void (async () => {
      try {
        const result = await importAistudioExportFiles();
        if (result && result.imported > 0) opts?.onImported?.(result);
      } catch (e) {
        showImportAlert(`导入失败：${String(e)}`, "error");
      }
    })();
  });
}
