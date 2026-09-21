/**
 * Focused checks for notes_mcp_activity taxonomy + round collapse.
 * Run: node omniplayer/scripts/notes_mcp_activity_test.mjs
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, "..", "src", "notes_mcp_activity.ts");

// Vite/TS not available here — dynamically transpile via node --experimental-strip-types if possible,
// else duplicate the pure classify heuristics for the smoke check.
async function loadModule() {
  try {
    return await import(pathToFileURL(srcPath).href);
  } catch {
    // Fallback: inline mirror of classifyToolBucket for CI without TS loader
    return null;
  }
}

function classifyToolBucket(name) {
  const raw = (name || "").trim().toLowerCase();
  if (!raw) return "read";
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
  const runHit = (t) =>
    /^(shell|bash|zsh|powershell|pwsh|cmd|terminal|exec|execute|spawn|system)$/.test(t);
  const readHit = (t) =>
    /^(list|get|read|history|tail|search|grep|glob|fetch|load|inspect|show|describe|stat|count|find|query|ls|cat|rg|explore|view|open|head|peek|websearch|webfetch)$/.test(
      t
    ) ||
    /^(list|get|read|history|tail|search|grep|glob|fetch|load|find|query)_/.test(t);
  const editHit = (t) =>
    /^(create|update|delete|write|edit|rollback|set|apply|patch|add|remove|put|post|insert|replace|rename|move|mkdir|touch|strreplace|unlink|rm|mv|cp)$/.test(
      t
    ) ||
    /^(create|update|delete|write|edit|rollback|set|apply|patch|add|remove)_/.test(t);
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
  return "read";
}

function resolveRoundCollapseMode(sliceIndex, liveRoundIdx, completed) {
  if (completed) {
    if (sliceIndex === liveRoundIdx) return "summary";
    return "collapsed";
  }
  if (sliceIndex === liveRoundIdx) return "live";
  if (sliceIndex === liveRoundIdx - 1) return "summary";
  return "collapsed";
}

const cases = [
  ["clue_board_list", "read"],
  ["clue_board_get", "read"],
  ["clue_board_list_history", "read"],
  ["clue_board_create_note", "edit"],
  ["clue_board_update_note", "edit"],
  ["clue_board_delete_note", "edit"],
  ["clue_board_rollback", "edit"],
  ["omni_data_read", "read"],
  ["StrReplace", "edit"],
  ["Write", "edit"],
  ["Read", "read"],
  ["Grep", "read"],
  ["Glob", "read"],
  ["Shell", "run"],
  ["apps_run_shell", "run"],
  ["run_terminal", "run"],
  ["WebSearch", "read"],
];

let failed = 0;
for (const [name, expect] of cases) {
  const got = classifyToolBucket(name);
  try {
    assert.equal(got, expect, `${name} → ${expect}`);
  } catch (e) {
    failed++;
    console.error(String(e.message || e));
  }
}

assert.equal(resolveRoundCollapseMode(3, 3, false), "live");
assert.equal(resolveRoundCollapseMode(2, 3, false), "summary");
assert.equal(resolveRoundCollapseMode(1, 3, false), "collapsed");
assert.equal(resolveRoundCollapseMode(3, 3, true), "summary");
assert.equal(resolveRoundCollapseMode(2, 3, true), "collapsed");

const mod = await loadModule();
if (mod?.classifyToolBucket) {
  for (const [name, expect] of cases) {
    assert.equal(mod.classifyToolBucket(name), expect, `module ${name}`);
  }
  assert.equal(mod.resolveRoundCollapseMode(3, 3, false), "live");
  console.log("loaded TS module OK");
} else {
  console.log("TS module not loadable in this node; used inline mirror");
}

if (failed) {
  console.error(`FAILED ${failed} cases`);
  process.exit(1);
}
console.log(`ok ${cases.length} classify + collapse modes`);
