/** MCP 回合中的 Cursor 式活动面板（整板折叠 / 多轮思考 / Explore·Edited）。 */

export type McpToolActivityStatus = "running" | "done" | "error";

/** Cursor 式两大桶：探索 vs 编辑（无「其它」同级桶）。 */
export type McpToolBucket = "explore" | "edited";

/** @deprecated 用 McpToolBucket；保留别名以免旧引用炸。 */
export type McpToolKind = McpToolBucket;

export type McpToolActivity = {
  id: string;
  name: string;
  target?: string | null;
  status: McpToolActivityStatus;
  detail?: string | null;
  /** 可选：后端若标了轮次则按轮分组；缺省时工具集中在末轮旁展示。 */
  round?: number | null;
  /**
   * 可选：后端显式桶（explore|edited|read|edit…）。
   * 有则优先于工具名启发式。
   */
  bucket?: string | null;
  /** 同 bucket；个别后端可能用 section / phase。 */
  section?: string | null;
  phase?: string | null;
};

export type McpStreamActivity = {
  phase?: string | null;
  round?: number | null;
  max_rounds?: number | null;
  waited_secs?: number | null;
  thinking?: { text?: string | null } | null;
  tools?: McpToolActivity[] | null;
};

/** 后端多轮思考用 `---` 拼接；前端拆成可各自折叠的块。 */
const THINK_SEP = /\n---\n/;

/** 长思考默认折叠阈值（字）。 */
const LONG_THINK_CHARS = 280;

export function hasMcpActivity(a: McpStreamActivity | null | undefined): boolean {
  if (!a) return false;
  const tools = a.tools?.length ?? 0;
  const think = (a.thinking?.text || "").trim().length > 0;
  const round = a.round != null;
  return tools > 0 || think || round || Boolean(a.phase);
}

function parseExplicitBucket(raw: string | null | undefined): McpToolBucket | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (
    s === "explore" ||
    s === "explored" ||
    s === "read" ||
    s === "reading" ||
    s === "search" ||
    s === "inspect"
  ) {
    return "explore";
  }
  if (
    s === "edited" ||
    s === "edit" ||
    s === "write" ||
    s === "writing" ||
    s === "mutate" ||
    s === "mutating"
  ) {
    return "edited";
  }
  return null;
}

/**
 * 从工具名推断 Explore / Edited。
 * Explore ≈ list|get|read|grep|search|glob|find|…
 * Edited ≈ create|update|delete|write|edit|patch|…
 * 未知默认归 Explore（不设第三同级桶）。
 */
export function classifyToolBucket(name: string): McpToolBucket {
  const raw = (name || "").trim().toLowerCase();
  if (!raw) return "explore";
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const exploreHit = (t: string) =>
    /^(list|get|read|history|tail|search|grep|glob|fetch|load|inspect|show|describe|stat|count|find|query|ls|cat|rg|explore|view|open|head|peek)$/.test(
      t
    ) ||
    /^(list|get|read|history|tail|search|grep|glob|fetch|load|find|query)_/.test(t);
  const editHit = (t: string) =>
    /^(create|update|delete|write|edit|rollback|set|apply|patch|add|remove|put|post|insert|replace|rename|move|mkdir|touch|strreplace|unlink|rm|mv|cp)$/.test(
      t
    ) ||
    /^(create|update|delete|write|edit|rollback|set|apply|patch|add|remove)_/.test(t);

  // 优先看末段（clue_board_list_history → history）
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (editHit(t)) return "edited";
    if (exploreHit(t)) return "explore";
  }
  for (const t of tokens) {
    if (editHit(t)) return "edited";
    if (exploreHit(t)) return "explore";
  }
  if (/(^|_)(list|get|read|history|tail|search|grep|glob|find)(_|$)/.test(raw)) {
    return "explore";
  }
  if (/(^|_)(create|update|delete|write|edit|rollback|set|apply|patch)(_|$)/.test(raw)) {
    return "edited";
  }
  // 未知 → Explore（检查类默认）
  return "explore";
}

/** 单工具归桶：显式字段优先，否则按名启发式。 */
export function resolveToolBucket(t: McpToolActivity): McpToolBucket {
  return (
    parseExplicitBucket(t.bucket) ??
    parseExplicitBucket(t.section) ??
    parseExplicitBucket(t.phase) ??
    classifyToolBucket(t.name)
  );
}

/** @deprecated 用 classifyToolBucket / resolveToolBucket */
export function classifyToolKind(name: string): McpToolBucket {
  return classifyToolBucket(name);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusLabel(st: McpToolActivityStatus): string {
  if (st === "running") return "运行中";
  if (st === "error") return "失败";
  return "完成";
}

function phaseLabel(phase: string | null | undefined, statusText: string): string {
  const p = (phase || "").trim();
  if (p === "done" || p === "completed") return "已完成";
  if (p === "waiting_model") return "等待模型…";
  if (p === "reading") return "读取响应…";
  if (p === "tool") return "调用工具…";
  if (p === "thinking") return "思考中…";
  if (p === "streaming") return "生成回复…";
  return statusText || "进行中…";
}

function bucketLabel(k: McpToolBucket): string {
  if (k === "edited") return "Edited";
  return "Explore";
}

function bucketLabelZh(k: McpToolBucket): string {
  if (k === "edited") return "编辑";
  return "探索";
}

function splitThinkingBlocks(text: string | null | undefined): string[] {
  const raw = (text || "").trim();
  if (!raw) return [];
  return raw
    .split(THINK_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ActivityOpenState = {
  /** section key → open */
  open: Record<string, boolean>;
};

/** 从已有面板读取折叠态，供 patch / 重建时保留用户操作。 */
export function snapshotActivityOpenState(el: HTMLElement | null): ActivityOpenState {
  const open: Record<string, boolean> = {};
  if (!el) return { open };
  el.querySelectorAll<HTMLDetailsElement>("details[data-act-key]").forEach((d) => {
    const key = d.dataset.actKey;
    if (key) open[key] = d.open;
  });
  // 根节点本身也可能是 details[data-act-key=panel]
  if (el instanceof HTMLDetailsElement && el.dataset.actKey) {
    open[el.dataset.actKey] = el.open;
  }
  return { open };
}

export type BuildMcpActivityOpts = {
  /** @deprecated 用 openState；若设了则作为首块思考的默认开合。 */
  thinkingOpen?: boolean;
  /** 回合已结束：头标「已完成」、长思考默认折叠；整板默认收起。 */
  completed?: boolean;
  /** 保留用户折叠态（key = data-act-key）。 */
  openState?: ActivityOpenState;
};

function resolveOpen(
  key: string,
  opts: BuildMcpActivityOpts | undefined,
  fallback: boolean
): boolean {
  if (opts?.openState?.open && key in opts.openState.open) {
    return Boolean(opts.openState.open[key]);
  }
  if (key.startsWith("think:") && opts?.thinkingOpen != null) {
    return Boolean(opts.thinkingOpen);
  }
  return fallback;
}

function makeDetails(
  key: string,
  summaryText: string,
  open: boolean,
  className: string
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = className;
  details.dataset.actKey = key;
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  details.appendChild(summary);
  return details;
}

function buildToolRow(
  t: McpToolActivity,
  completed: boolean,
  opts: BuildMcpActivityOpts | undefined
): HTMLElement {
  const stVal = (t.status || "done") as McpToolActivityStatus;
  const showSt = completed && stVal === "running" ? ("done" as const) : stVal;
  const target = (t.target || "").trim();
  const detail = (t.detail || "").trim();
  const expandable = Boolean(target || detail);
  const key = `tool:${t.id || t.name}`;
  const bucket = resolveToolBucket(t);

  if (!expandable) {
    const li = document.createElement("li");
    li.className = "notes-card-activity-tool";
    li.dataset.status = showSt;
    li.dataset.bucket = bucket;
    const name = document.createElement("span");
    name.className = "notes-card-activity-tool-name";
    name.textContent = t.name || "tool";
    const st = document.createElement("span");
    st.className = "notes-card-activity-tool-status";
    st.textContent = statusLabel(showSt);
    li.append(name, st);
    return li;
  }

  const details = makeDetails(
    key,
    "",
    resolveOpen(key, opts, showSt === "running"),
    "notes-card-activity-tool is-expandable"
  );
  details.dataset.status = showSt;
  details.dataset.bucket = bucket;
  const summary = details.querySelector("summary")!;
  summary.className = "notes-card-activity-tool-sum";
  const name = document.createElement("span");
  name.className = "notes-card-activity-tool-name";
  name.textContent = t.name || "tool";
  const preview = document.createElement("span");
  preview.className = "notes-card-activity-tool-target";
  if (target) {
    preview.textContent = target;
    preview.title = target;
  }
  const st = document.createElement("span");
  st.className = "notes-card-activity-tool-status";
  st.textContent = statusLabel(showSt);
  if (detail) st.title = detail;
  summary.append(name);
  if (target) summary.appendChild(preview);
  summary.appendChild(st);

  const body = document.createElement("div");
  body.className = "notes-card-activity-tool-body";
  if (target) {
    const row = document.createElement("div");
    row.className = "notes-card-activity-tool-meta";
    row.innerHTML = `<span class="notes-card-activity-tool-meta-k">目标</span>`;
    const v = document.createElement("span");
    v.className = "notes-card-activity-tool-meta-v";
    v.textContent = target;
    row.appendChild(v);
    body.appendChild(row);
  }
  if (detail) {
    const row = document.createElement("div");
    row.className = "notes-card-activity-tool-meta";
    row.innerHTML = `<span class="notes-card-activity-tool-meta-k">详情</span>`;
    const v = document.createElement("pre");
    v.className = "notes-card-activity-tool-meta-v notes-card-activity-tool-detail";
    v.textContent = detail;
    row.appendChild(v);
    body.appendChild(row);
  }
  details.appendChild(body);
  return details;
}

/**
 * 按工具独立归桶；每桶内保持 `tools` 数组顺序（= 时间序）。
 * 不设「其它」同级桶：未知归 Explore。
 */
export function groupToolsByBucket(
  tools: McpToolActivity[]
): { bucket: McpToolBucket; tools: McpToolActivity[] }[] {
  const explore: McpToolActivity[] = [];
  const edited: McpToolActivity[] = [];
  for (const t of tools) {
    if (resolveToolBucket(t) === "edited") edited.push(t);
    else explore.push(t);
  }
  const out: { bucket: McpToolBucket; tools: McpToolActivity[] }[] = [];
  if (explore.length) out.push({ bucket: "explore", tools: explore });
  if (edited.length) out.push({ bucket: "edited", tools: edited });
  return out;
}

type RoundSlice = {
  index: number; // 1-based display
  thinking?: string;
  tools: McpToolActivity[];
};

/**
 * 把扁平 activity 收成「轮」：思考按 `---` 拆；带 round 的工具归入对应轮；
 * 未标 round 的工具挂在最后一轮（或单独工具轮）。
 */
export function normalizeActivityRounds(activity: McpStreamActivity): RoundSlice[] {
  const thinks = splitThinkingBlocks(activity.thinking?.text);
  const tools = activity.tools ?? [];
  const tagged = tools.filter((t) => t.round != null && Number(t.round) > 0);
  const untagged = tools.filter((t) => !(t.round != null && Number(t.round) > 0));

  const roundCount = Math.max(
    thinks.length,
    tagged.reduce((m, t) => Math.max(m, Number(t.round) || 0), 0),
    activity.round != null && activity.round > 0 ? activity.round : 0,
    thinks.length || tools.length ? 1 : 0
  );

  if (roundCount === 0) return [];

  const n = Math.max(roundCount, thinks.length || (tools.length ? 1 : 0));
  const slices: RoundSlice[] = [];
  for (let i = 1; i <= n; i++) {
    slices.push({
      index: i,
      thinking: thinks[i - 1],
      tools: tagged.filter((t) => Number(t.round) === i),
    });
  }

  // 未标 round：全部挂到「当前/最后」一轮，避免伪造分割
  if (untagged.length) {
    const last = slices[slices.length - 1] ?? {
      index: 1,
      tools: [] as McpToolActivity[],
    };
    if (!slices.length) slices.push(last);
    slices[slices.length - 1].tools.push(...untagged);
  }

  // 去掉完全空的中间轮（无思考无工具）；保留有内容的
  const filtered = slices.filter((s) => s.thinking || s.tools.length);
  return filtered.length ? filtered : slices;
}

function appendToolList(
  parent: HTMLElement,
  tools: McpToolActivity[],
  completed: boolean,
  opts: BuildMcpActivityOpts | undefined
) {
  const list = document.createElement("ul");
  list.className = "notes-card-activity-tools";
  for (const t of tools) {
    const row = buildToolRow(t, completed, opts);
    if (row.tagName === "LI") list.appendChild(row);
    else {
      const li = document.createElement("li");
      li.className = "notes-card-activity-tool-li";
      li.appendChild(row);
      list.appendChild(li);
    }
  }
  parent.appendChild(list);
}

/** 构建活动面板 DOM（不挂载）。根节点为可折叠 `<details>`。 */
export function buildMcpActivityEl(
  activity: McpStreamActivity,
  statusText: string,
  opts?: BuildMcpActivityOpts
): HTMLElement {
  const completed = Boolean(opts?.completed);
  const root = document.createElement("details");
  root.className = "notes-card-activity" + (completed ? " is-done" : "");
  root.dataset.actKey = "panel";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", completed ? "off" : "polite");
  // 运行中默认展开；结束后默认收起；用户操作经 openState 保留
  root.open = resolveOpen("panel", opts, !completed);

  const head = document.createElement("summary");
  head.className = "notes-card-activity-head";
  const round =
    activity.round != null && activity.max_rounds != null
      ? `回合 ${activity.round}/${activity.max_rounds}`
      : activity.round != null
        ? `回合 ${activity.round}`
        : "";
  const waited =
    !completed &&
    activity.waited_secs != null &&
    activity.waited_secs > 0
      ? `已等待 ${activity.waited_secs}s`
      : "";
  const phase = completed ? "已完成" : phaseLabel(activity.phase, statusText);
  const bits = [round, phase, waited].filter(Boolean);
  head.textContent = bits.join(" · ") || (completed ? "MCP 活动" : "MCP 活动…");
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "notes-card-activity-body";

  const rounds = normalizeActivityRounds(activity);
  const liveRoundIdx = rounds.length ? rounds[rounds.length - 1].index : 0;

  for (const slice of rounds) {
    const block = document.createElement("section");
    block.className = "notes-card-activity-round";
    block.dataset.round = String(slice.index);

    if (rounds.length > 1) {
      const lab = document.createElement("div");
      lab.className = "notes-card-activity-round-lab";
      lab.textContent = `第 ${slice.index} 轮`;
      block.appendChild(lab);
    }

    if (slice.thinking) {
      const thinkKey = `think:${slice.index}`;
      const long = slice.thinking.length >= LONG_THINK_CHARS;
      const isLiveThink =
        !completed &&
        slice.index === liveRoundIdx &&
        (activity.phase === "thinking" ||
          activity.phase === "waiting_model" ||
          activity.phase === "reading" ||
          !activity.phase);
      // Cursor 感：结束后长思考默认折；运行中当前块可展开
      const defaultOpen = completed ? !long : isLiveThink || !long;
      const details = makeDetails(
        thinkKey,
        `思考（${slice.thinking.length} 字）`,
        resolveOpen(thinkKey, opts, defaultOpen),
        "notes-card-activity-think"
      );
      const thinkBody = document.createElement("pre");
      thinkBody.className = "notes-card-activity-think-body";
      thinkBody.textContent = slice.thinking;
      details.appendChild(thinkBody);
      block.appendChild(details);
    }

    const groups = groupToolsByBucket(slice.tools);
    for (const g of groups) {
      const gKey = `bucket:${slice.index}:${g.bucket}`;
      const anyRunning = g.tools.some((t) => t.status === "running");
      const defaultOpen = !completed || anyRunning || g.tools.length <= 6;
      const details = makeDetails(
        gKey,
        `${bucketLabel(g.bucket)} · ${bucketLabelZh(g.bucket)}（${g.tools.length}）`,
        resolveOpen(gKey, opts, defaultOpen),
        `notes-card-activity-bucket notes-card-activity-bucket-${g.bucket}`
      );
      details.dataset.bucket = g.bucket;
      appendToolList(details, g.tools, completed, opts);
      block.appendChild(details);
    }

    if (block.childElementCount) body.appendChild(block);
  }

  root.appendChild(body);
  return root;
}

/** 就地刷新已有面板；返回是否成功（否则调用方应重建）。 */
export function patchMcpActivityEl(
  el: HTMLElement,
  activity: McpStreamActivity,
  statusText: string,
  opts?: BuildMcpActivityOpts
): boolean {
  if (!el.classList.contains("notes-card-activity")) return false;
  const openState = snapshotActivityOpenState(el);
  const next = buildMcpActivityEl(activity, statusText, {
    ...opts,
    openState: opts?.openState ?? openState,
  });
  el.replaceWith(next);
  return true;
}

export function activityToDebugHtml(activity: McpStreamActivity): string {
  return `<pre>${escapeHtml(JSON.stringify(activity, null, 2))}</pre>`;
}

/**
 * 从协议日志重建活动面板（无落盘 mcp_activity 的旧卡）。
 * 解析 `event.kind` = tool_call / tool_result；思考正文通常不在日志里。
 * 若日志带 `mcp_round`，写入 tool.round 以便分轮展示。
 */
export function activityFromProtocolLog(
  raw: string
): McpStreamActivity | null {
  const tools: McpToolActivity[] = [];
  let roundMax = 0;
  let currentRound: number | null = null;
  const lines = (raw || "").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let row: { event?: Record<string, unknown> };
    try {
      row = JSON.parse(t) as { event?: Record<string, unknown> };
    } catch {
      continue;
    }
    const ev = row.event;
    if (!ev || typeof ev !== "object") continue;
    const kind = String(ev.kind || "");
    if (kind === "request" && typeof ev.mcp_round === "number") {
      currentRound = (ev.mcp_round as number) + 1;
      roundMax = Math.max(roundMax, currentRound);
    } else if (kind === "tool_call") {
      const name = String(ev.name || "tool");
      const target =
        typeof ev.target === "string" && ev.target.trim()
          ? ev.target.trim()
          : null;
      const id = `log-${tools.length + 1}-${name}`;
      const r =
        typeof ev.mcp_round === "number"
          ? (ev.mcp_round as number) + 1
          : currentRound;
      tools.push({
        id,
        name,
        target,
        status: "running",
        detail: null,
        round: r,
      });
      if (r != null) roundMax = Math.max(roundMax, r);
      else roundMax = Math.max(roundMax, tools.length);
    } else if (kind === "tool_result") {
      const name = String(ev.name || "");
      const ok = ev.ok !== false;
      const target =
        typeof ev.target === "string" && ev.target.trim()
          ? ev.target.trim()
          : null;
      let last = [...tools]
        .reverse()
        .find((x) => x.name === name && x.status === "running");
      if (!last) {
        last = {
          id: `log-res-${tools.length + 1}`,
          name: name || "tool",
          target,
          status: ok ? "done" : "error",
          detail: null,
          round: currentRound,
        };
        tools.push(last);
      } else {
        last.status = ok ? "done" : "error";
        if (target && !last.target) last.target = target;
      }
    }
  }
  for (const t of tools) {
    if (t.status === "running") t.status = "done";
  }
  if (!tools.length) return null;
  return {
    phase: "done",
    round: roundMax || tools.length,
    max_rounds: null,
    waited_secs: null,
    thinking: null,
    tools,
  };
}

/** 回合结束后规范化：phase=done，运行中工具标为完成。 */
export function finalizeActivityForDone(
  activity: McpStreamActivity | null | undefined
): McpStreamActivity | null {
  if (!hasMcpActivity(activity)) return null;
  const a = activity as McpStreamActivity;
  return {
    ...a,
    phase: "done",
    waited_secs: null,
    tools: (a.tools ?? []).map((t) =>
      t.status === "running" ? { ...t, status: "done" as const } : t
    ),
  };
}
