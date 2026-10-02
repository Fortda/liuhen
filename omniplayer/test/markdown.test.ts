import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAssistantMarkdown } from "../src/notes_markdown.ts";

test("assistant markdown escapes raw html and rejects non-http links", () => {
  const html = renderAssistantMarkdown(
    '<img src=x onerror="alert(1)">\n\n[ok](https://example.com/a)\n\n[bad](javascript:alert(1))'
  );
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.equal(html.includes('href="javascript:'), false);
});
