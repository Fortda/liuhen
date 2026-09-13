/**
 * 流式笔记助手气泡：轻量 Markdown → 安全 HTML（先转义再排版，不执行原文 HTML）。
 * 无第三方 marked；覆盖常用子集即可。
 */

const MD_PREF_KEY = "omnitrace.notes.assistantMarkdown";

/** 默认开：模型常吐 markdown，原文可读性差 */
export function isAssistantMarkdownOn(): boolean {
  try {
    const v = localStorage.getItem(MD_PREF_KEY);
    if (v === null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

export function setAssistantMarkdownOn(on: boolean) {
  try {
    localStorage.setItem(MD_PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMd(escaped: string): string {
  let s = escaped;
  // `code`
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // **bold** / __bold__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // *italic* / _italic_（避免吃掉已转 strong 的边界）
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  // [text](http…) — 只允许 http(s)
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return s;
}

/**
 * 将模型原文转成可放入气泡的 HTML。输入按纯文本处理（先 escape）。
 */
export function renderAssistantMarkdown(src: string): string {
  const text = src.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const flushCode = () => {
    const body = codeBuf.join("\n");
    const lang = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : "";
    out.push(`<pre class="notes-md-pre"${lang}><code>${body}</code></pre>`);
    codeBuf = [];
    codeLang = "";
  };

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^```/.test(line)) {
        inCode = false;
        flushCode();
      } else {
        codeBuf.push(escapeHtml(line));
      }
      i++;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      inCode = true;
      codeLang = fence[1] || "";
      i++;
      continue;
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      i++;
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level} class="notes-md-h">${inlineMd(escapeHtml(h[2]))}</h${level}>`);
      i++;
      continue;
    }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      closeList();
      const parts = [bq[1]];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^>\s?(.*)$/);
        if (!m) break;
        parts.push(m[1]);
        i++;
      }
      out.push(
        `<blockquote class="notes-md-quote">${inlineMd(
          escapeHtml(parts.join("\n"))
        ).replace(/\n/g, "<br />")}</blockquote>`
      );
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        out.push('<ul class="notes-md-list">');
      }
      out.push(`<li>${inlineMd(escapeHtml(ul[1]))}</li>`);
      i++;
      continue;
    }

    const ol = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        out.push('<ol class="notes-md-list">');
      }
      out.push(`<li>${inlineMd(escapeHtml(ol[2]))}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    closeList();
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const n = lines[i];
      if (
        !n.trim() ||
        /^```/.test(n) ||
        /^#{1,3}\s/.test(n) ||
        /^\s*[-*+]\s+/.test(n) ||
        /^\s*\d+\.\s+/.test(n) ||
        /^>\s?/.test(n) ||
        /^\s*---+\s*$/.test(n)
      ) {
        break;
      }
      para.push(n);
      i++;
    }
    out.push(
      `<p class="notes-md-p">${inlineMd(escapeHtml(para.join("\n"))).replace(
        /\n/g,
        "<br />"
      )}</p>`
    );
  }

  if (inCode) flushCode();
  closeList();
  return out.join("") || `<p class="notes-md-p">${inlineMd(escapeHtml(text))}</p>`;
}

/** 写入助手气泡：markdown 开且非占位/错误时渲染；否则纯文本。 */
export function fillAssistantBubble(
  el: HTMLElement,
  text: string,
  opts: { markdown: boolean; plain?: boolean }
) {
  if (opts.plain || !opts.markdown || !text) {
    el.classList.remove("is-md");
    el.textContent = text;
    return;
  }
  el.classList.add("is-md");
  el.innerHTML = renderAssistantMarkdown(text);
}
