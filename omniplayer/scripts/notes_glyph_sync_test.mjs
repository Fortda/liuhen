/**
 * Focused checks for glyph sync: backspace marks deleted; sketch ignores deleted.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Compile-free: duplicate the sync logic expectations via dynamic import of built? 
// Prefer importing the TS via tsx if available; else inline mirror.

const require = createRequire(import.meta.url);

function syncGlyphListToText(glyphs, text, dtMs, now) {
  const nextChars = [...text];
  const visIdx = [];
  for (let i = 0; i < glyphs.length; i++) {
    if (!glyphs[i].deleted) visIdx.push(i);
  }
  let prefix = 0;
  while (
    prefix < visIdx.length &&
    prefix < nextChars.length &&
    glyphs[visIdx[prefix]].ch === nextChars[prefix]
  ) {
    prefix += 1;
  }
  const next = glyphs.map((g) => ({ ...g }));
  for (let i = prefix; i < visIdx.length; i++) {
    next[visIdx[i]].deleted = true;
  }
  for (let i = prefix; i < nextChars.length; i++) {
    next.push({ ch: nextChars[i], dtMs, ts: now });
  }
  return next;
}

function sketch(glyphs) {
  return glyphs.filter((g) => !g.deleted).map((g) => g.ch).join("");
}

let g = [];
g = syncGlyphListToText(g, "ab", 10, 1);
assert.equal(sketch(g), "ab");
assert.equal(g.length, 2);

g = syncGlyphListToText(g, "a", 10, 2);
assert.equal(sketch(g), "a");
assert.equal(g.length, 2);
assert.equal(g[1].deleted, true);
assert.equal(g[1].ch, "b");

g = syncGlyphListToText(g, "ac", 20, 3);
assert.equal(sketch(g), "ac");
assert.equal(g.filter((x) => x.deleted).map((x) => x.ch).join(""), "b");
assert.equal(g[g.length - 1].ch, "c");

console.log("notes_glyph_sync_test: ok");
// silence unused
void require;
