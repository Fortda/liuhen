import { shellT } from "./shell_i18n";

export type McpToolActivityStatus = "running" | "done" | "error";

/**
 * 助手活动可见动作桶（Cursor 式短标签）。
 * thinking 不在此桶：它是独立折叠块。
 * mcp = 第五兜底（无法归入 read/edit/run 时）；优先按动词归入四类。
 */
export type McpToolBucket = "read" | "edit" | "run" | "mcp";

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
   * 可选：后端显式桶（read|edit|run|mcp；旧 explore→read、edited→edit）。
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

/** 轮次渐进折叠：当前最细 / 上一轮概览 / 更早整轮收起。 */
export type RoundCollapseMode = "live" | "summary" | "collapsed";

/** 后端多轮思考用 `---` 拼接；前端拆成可各自折叠的块。 */
const THINK_SEP = /\n---\n/;

/** 长思考默认折叠阈值（字）。 */
const LONG_THINK_CHARS = 280;

const BUCKET_ORDER: McpToolBucket[] = ["read", "edit", "run", "mcp"];

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
    s === "read" ||
    s === "reading" ||
    s === "explore" ||
    s === "explored" ||
    s === "search" ||
    s === "inspect"
  ) {
    return "read";
  }
  if (
    s === "edit" ||
    s === "edited" ||
    s === "write" ||
    s === "writing" ||
    s === "mutate" ||
    s === "mutating" ||
    s === "patch"
  ) {
    return "edit";
  }
  if (
    s === "run" ||
    s === "shell" ||
    s === "command" ||
    s === "exec" ||
    s === "terminal" ||
    s === "powershell" ||
    s === "bash" ||
    s === "cmd"
  ) {
    return "run";
  }
  if (s === "mcp" || s === "tool" || s === "other") {
    return "mcp";
  }
  return null;
}

/**
 * 从工具名推断 read / edit / run / mcp。
 * read ≈ list|get|read|grep|search|glob|…
 * edit ≈ create|update|delete|write|edit|patch|…
 * run ≈ shell|exec|bash|powershell|apps_run_shell|…
 * 未知默认归 read（检查类）；不轻易开 mcp 同级桶。
 */
export function classifyToolBucket(name: string): McpToolBucket {
  const raw = (name || "").trim().toLowerCase();
  if (!raw) return "read";

  // 整名优先：shell / 命令行类
  if (
    /^(apps_run_shell|run_shell|run_terminal|run_command|shell_exec|execute_command)$/.test(
      raw
    ) ||
    /(^|_)(shell|powershell|bash|cmd|terminal|exec)(_|$)/.test(raw) ||
    /^run_/.test(raw)
  ) {
    return "run";
  }

  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const runHit = (t: string) =>
    /^(shell|bash|zsh|powershell|pwsh|cmd|terminal|exec|execute|spawn|system)$/.test(t);
  const readHit = (t: string) =>
    /^(list|get|read|history|tail|search|grep|glob|fetch|load|inspect|show|describe|stat|count|find|query|ls|cat|rg|explore|view|open|head|peek|websearch|webfetch)$/.test(
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
    if (runHit(t)) return "run";
    if (editHit(t)) return "edit";
    if (readHit(t)) return "read";
  }
  for (const t of tokens) {
    if (runHit(t)) return "run";
    if (editHit(t)) return "edit";
    if (readHit(t)) return "read";
  }
  if (/(^|_)(list|get|read|history|tail|search|grep|glob|find)(_|$)/.test(raw)) {
    return "read";
  }
  if (/(^|_)(create|update|delete|write|edit|rollback|set|apply|patch)(_|$)/.test(raw)) {
    return "edit";
  }
  // 未知 → read（检查类默认）
  return "read";
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
  if (st === "running") return shellT("notes.activity.running");
  if (st === "error") return shellT("notes.activity.error");
  return shellT("notes.activity.complete");
}

function phaseLabel(phase: string | null | undefined, statusText: string): string {
  const p = (phase || "").trim();
  if (p === "done" || p === "completed") return shellT("notes.activity.done");
  if (p === "waiting_model") return shellT("notes.activity.waitingModel");
  if (p === "reading") return shellT("notes.activity.reading");
  if (p === "tool") return shellT("notes.activity.tool");
  if (p === "thinking") return shellT("notes.activity.phaseThinking");
  if (p === "streaming") return shellT("notes.activity.streaming");
  return statusText || shellT("notes.activity.running");
}

function bucketLabel(k: McpToolBucket): string {
  if (k === "edit") return shellT("notes.activity.edit");
  if (k === "run") return shellT("notes.activity.run");
  if (k === "mcp") return shellT("notes.activity.mcp");
  return shellT("notes.activity.read");
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
  fallback: boolean,
  /** 非 live 轮忽略 think/bucket 的旧展开态，以免流式 patch 把上一轮锁在细览。 */
  collapseMode?: RoundCollapseMode
): boolean {
  if (opts?.openState?.open && key in opts.openState.open) {
    if (
      (collapseMode === "summary" || collapseMode === "collapsed") &&
      (key.startsWith("think:") || key.startsWith("bucket:") || key.startsWith("tool:"))
    ) {
      return fallback;
    }
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
  opts: BuildMcpActivityOpts | undefined,
  forceOpenLive: boolean,
  collapseMode: RoundCollapseMode = "live"
): HTMLElement {
  const stVal = (t.status || "done") as McpToolActivityStatus;
  const showSt = completed && stVal === "running" ? ("done" as const) : stVal;
  const target = (t.target || "").trim();
  const detail = (t.detail || "").trim();
  const expandable = Boolean(target || detail);
  const key = `tool:${t.id || t.name}`;
  const bucket = resolveToolBucket(t);
  const defaultOpen =
    collapseMode === "live" && (forceOpenLive || showSt === "running");

  if (!expandable) {
    const li = document.createElement("li");
    li.className = "notes-card-activity-tool";
    li.dataset.status = showSt;
    li.dataset.bucket = bucket;
    if (forceOpenLive) li.dataset.live = "1";
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
    resolveOpen(key, opts, defaultOpen, collapseMode),
    "notes-card-activity-tool is-expandable"
  );
  details.dataset.status = showSt;
  details.dataset.bucket = bucket;
  if (forceOpenLive) details.dataset.live = "1";
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
    row.innerHTML = `<span class="notes-card-activity-tool-meta-k">${shellT("notes.activity.target")}</span>`;
    const v = document.createElement("span");
    v.className = "notes-card-activity-tool-meta-v";
    v.textContent = target;
    row.appendChild(v);
    body.appendChild(row);
  }
  if (detail) {
    const row = document.createElement("div");
    row.className = "notes-card-activity-tool-meta";
    row.innerHTML = `<span class="notes-card-activity-tool-meta-k">${shellT("notes.activity.detail")}</span>`;
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
 * 桶出现顺序固定：read → edit → run → mcp（空桶省略）。
 */
export function groupToolsByBucket(
  tools: McpToolActivity[]
): { bucket: McpToolBucket; tools: McpToolActivity[] }[] {
  const bags: Record<McpToolBucket, McpToolActivity[]> = {
    read: [],
    edit: [],
    run: [],
    mcp: [],
  };
  for (const t of tools) {
    bags[resolveToolBucket(t)].push(t);
  }
  const out: { bucket: McpToolBucket; tools: McpToolActivity[] }[] = [];
  for (const bucket of BUCKET_ORDER) {
    if (bags[bucket].length) out.push({ bucket, tools: bags[bucket] });
  }
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

/** 轮次概览短标签：思考 · 读取 2 · 编辑 1 · 命令行 1 */
export function roundOverviewLine(slice: RoundSlice): string {
  const bits: string[] = [];
  if (slice.thinking) bits.push(shellT("notes.activity.thinking"));
  for (const g of groupToolsByBucket(slice.tools)) {
    bits.push(`${bucketLabel(g.bucket)} ${g.tools.length}`);
  }
  return bits.join(" · ");
}

/**
 * 渐进折叠：当前轮最细；上一轮概览；更早整轮收起。
 * 已结束时无「运行中」轮：末轮当 summary，更早 collapsed。
 */
export function resolveRoundCollapseMode(
  sliceIndex: number,
  liveRoundIdx: number,
  completed: boolean
): RoundCollapseMode {
  if (completed) {
    if (sliceIndex === liveRoundIdx) return "summary";
    return "collapsed";
  }
  if (sliceIndex === liveRoundIdx) return "live";
  if (sliceIndex === liveRoundIdx - 1) return "summary";
  return "collapsed";
}

function appendToolList(
  parent: HTMLElement,
  tools: McpToolActivity[],
  completed: boolean,
  opts: BuildMcpActivityOpts | undefined,
  liveToolId: string | null,
  collapseMode: RoundCollapseMode
) {
  const list = document.createElement("ul");
  list.className = "notes-card-activity-tools";
  for (const t of tools) {
    const forceOpen = Boolean(liveToolId && (t.id === liveToolId || t.name === liveToolId));
    const row = buildToolRow(t, completed, opts, forceOpen, collapseMode);
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

function findLiveTool(tools: McpToolActivity[]): McpToolActivity | null {
  const running = tools.find((t) => t.status === "running");
  return running || null;
}

function isLiveThinkingPhase(phase: string | null | undefined): boolean {
  const p = (phase || "").trim();
  return (
    p === "thinking" ||
    p === "waiting_model" ||
    p === "reading" ||
    !p
  );
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
      ? `${shellT("notes.activity.round", { n: `${activity.round}/${activity.max_rounds}` })}`
      : activity.round != null
        ? shellT("notes.activity.round", { n: String(activity.round) })
        : "";
  const waited =
    !completed &&
    activity.waited_secs != null &&
    activity.waited_secs > 0
      ? shellT("notes.activity.waited", { n: String(activity.waited_secs) })
      : "";
  const phase = completed ? shellT("notes.activity.done") : phaseLabel(activity.phase, statusText);
  const bits = [round, phase, waited].filter(Boolean);
  head.textContent = bits.join(" · ") || shellT("notes.activity.panel");
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "notes-card-activity-body";

  const rounds = normalizeActivityRounds(activity);
  const liveRoundIdx = rounds.length ? rounds[rounds.length - 1].index : 0;

  for (const slice of rounds) {
    const mode = resolveRoundCollapseMode(slice.index, liveRoundIdx, completed);
    const overview = roundOverviewLine(slice);
    const roundKey = `round:${slice.index}`;
    const defaultRoundOpen = mode !== "collapsed";
    const block = makeDetails(
      roundKey,
      "",
      resolveOpen(roundKey, opts, defaultRoundOpen, mode),
      `notes-card-activity-round notes-card-activity-round-${mode}`
    );
    block.dataset.round = String(slice.index);
    block.dataset.collapse = mode;

    const sum = block.querySelector("summary")!;
    sum.className = "notes-card-activity-round-sum";
    const lab = document.createElement("span");
    lab.className = "notes-card-activity-round-lab";
    lab.textContent = shellT("notes.activity.round", { n: String(slice.index) });
    sum.appendChild(lab);
    if (overview) {
      const ov = document.createElement("span");
      ov.className = "notes-card-activity-round-overview";
      ov.textContent = overview;
      ov.title = overview;
      sum.appendChild(ov);
    }

    // 更早轮：只留一行概览，内容仍挂上以便手动展开
    const inner = document.createElement("div");
    inner.className = "notes-card-activity-round-body";

    const groups = groupToolsByBucket(slice.tools);
    const liveTool = mode === "live" ? findLiveTool(slice.tools) : null;
    const liveBucket = liveTool ? resolveToolBucket(liveTool) : null;
    const liveThink =
      mode === "live" &&
      !liveTool &&
      Boolean(slice.thinking) &&
      isLiveThinkingPhase(activity.phase);

    if (slice.thinking) {
      const thinkKey = `think:${slice.index}`;
      const long = slice.thinking.length >= LONG_THINK_CHARS;
      let defaultOpen = false;
      if (mode === "live") {
        defaultOpen = liveThink || (!liveTool && !long);
      } else if (mode === "summary") {
        defaultOpen = false;
      } else {
        defaultOpen = false;
      }
      const details = makeDetails(
        thinkKey,
        shellT("notes.activity.thinking"),
        resolveOpen(thinkKey, opts, defaultOpen, mode),
        "notes-card-activity-think" + (liveThink ? " is-live" : "")
      );
      const thinkBody = document.createElement("pre");
      thinkBody.className = "notes-card-activity-think-body";
      thinkBody.textContent = slice.thinking;
      details.appendChild(thinkBody);
      inner.appendChild(details);
    }

    for (const g of groups) {
      const gKey = `bucket:${slice.index}:${g.bucket}`;
      const anyRunning = g.tools.some((t) => t.status === "running");
      const isLiveBucket = mode === "live" && liveBucket === g.bucket;
      let defaultOpen = false;
      if (mode === "live") {
        // 当前执行桶展开；同轮其它桶更紧凑（仅运行中或很少条目时开）
        defaultOpen = isLiveBucket || anyRunning || (!liveBucket && g.tools.length <= 3);
      } else if (mode === "summary") {
        defaultOpen = false;
      }
      const details = makeDetails(
        gKey,
        `${bucketLabel(g.bucket)}（${g.tools.length}）`,
        resolveOpen(gKey, opts, defaultOpen, mode),
        `notes-card-activity-bucket notes-card-activity-bucket-${g.bucket}` +
          (isLiveBucket ? " is-live" : "")
      );
      details.dataset.bucket = g.bucket;
      appendToolList(
        details,
        g.tools,
        completed,
        opts,
        isLiveBucket && liveTool ? liveTool.id || liveTool.name : null,
        mode
      );
      inner.appendChild(details);
    }

    if (inner.childElementCount) block.appendChild(inner);
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
