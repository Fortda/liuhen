/**
 * Pure checks for clue-board image refs, paste remap, and Ctrl+C / Ctrl+V.
 * Run: node omniplayer/scripts/clue_clipboard_test.mjs
 */
import {
  clueClipboardPlainText,
  clueShortcutAction,
  decodeClueClipboardHtml,
  encodeClueClipboardHtml,
  normalizeClueImageRef,
  remapCluePaste,
} from "../src/notes_clue_clipboard.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  normalizeClueImageRef("clue_images/Ab_1.PNG") === "clue_images/Ab_1.png",
  "ext lowercased"
);
assert(normalizeClueImageRef("clue_images/../x.png") === undefined, "reject traversal");
assert(normalizeClueImageRef("C:/secret.png") === undefined, "reject absolute");
assert(
  normalizeClueImageRef("data:image/png;base64,aaaa") === undefined,
  "reject data url"
);
assert(normalizeClueImageRef("") === undefined, "reject empty");

const payload = {
  v: 1,
  nodes: [
    {
      id: "a",
      text: "parent",
      x: 10,
      y: 20,
      kind: "project",
      image: "clue_images/pic.png",
    },
    { id: "b", text: "child", x: 40, y: 50, parentId: "a" },
    { id: "c", text: "outside-parent", x: 0, y: 0, parentId: "missing" },
  ],
  edges: [
    { id: "e1", from: "a", to: "b" },
    { id: "e2", from: "a", to: "other" },
  ],
};

const html = encodeClueClipboardHtml(payload);
const back = decodeClueClipboardHtml(html);
assert(back && back.nodes.length === 3, "html roundtrip");
assert(clueClipboardPlainText(payload.nodes).includes("parent"), "plain text");
assert(!html.includes("parent"), "html is not the note text");

let n = 0;
const pasted = remapCluePaste(payload.nodes, payload.edges, {
  dx: 28,
  dy: 28,
  newNodeId: () => `n${++n}`,
  newEdgeId: () => `edge${n}`,
});
assert(pasted.nodes.length === 3, "all nodes pasted");
assert(pasted.nodes.every((node, i) => node.id !== payload.nodes[i].id), "new ids");
assert(pasted.nodes[0].x === 38 && pasted.nodes[0].y === 48, "offset");
assert(pasted.nodes[0].kind === "project", "kind kept");
assert(pasted.nodes[0].image === "clue_images/pic.png", "image ref shared");
assert(pasted.nodes[1].parentId === pasted.nodes[0].id, "internal parent remapped");
assert(!pasted.nodes[2].parentId, "external parent dropped");
assert(pasted.edges.length === 1, "only internal edge");
assert(
  pasted.edges[0].from === pasted.nodes[0].id &&
    pasted.edges[0].to === pasted.nodes[1].id,
  "edge endpoints remapped"
);

const base = {
  clueMode: true,
  mod: true,
  key: "c",
  fieldFocused: false,
  fieldHasCharSelection: false,
  selectedNoteCount: 2,
};
assert(clueShortcutAction(base) === "copy-notes", "copy selection");
assert(
  clueShortcutAction({ ...base, fieldFocused: true, fieldHasCharSelection: true }) ===
    "browser-text",
  "selected characters win"
);
assert(
  clueShortcutAction({ ...base, fieldFocused: true, fieldHasCharSelection: false }) ===
    "copy-notes",
  "focused field with empty selection copies notes"
);
assert(
  clueShortcutAction({ ...base, selectedNoteCount: 0, fieldFocused: true }) === "ignore",
  "nothing selected"
);
assert(
  clueShortcutAction({ ...base, key: "v", fieldFocused: false }) === "paste-board",
  "paste on board"
);
assert(
  clueShortcutAction({ ...base, key: "v", fieldFocused: true, fieldHasCharSelection: true }) ===
    "browser-text",
  "paste into field"
);
assert(clueShortcutAction({ ...base, clueMode: false }) === "ignore", "inactive board");
assert(clueShortcutAction({ ...base, key: "z" }) === "ignore", "undo stays separate");

console.log("clue clipboard tests OK");
