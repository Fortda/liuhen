import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHttpUrl, resolveSearchRequest } from "../dist/search.js";

const base = { v: 1, engine: "duckduckgo", searx_url: "", custom_url: "", api_key: "" };

test("default search stays on duckduckgo https", () => {
  const req = resolveSearchRequest(base, "liuhen notes");
  assert.equal(req.engine, "duckduckgo");
  assert.equal(assertHttpUrl(req.url).protocol, "https:");
  assert.match(req.url, /q=liuhen\+notes/);
});

test("custom search rejects non-http schemes and encodes the query", () => {
  assert.throws(
    () =>
      resolveSearchRequest(
        { ...base, engine: "custom", custom_url: "file:///etc/passwd?q={{q}}" },
        "x"
      ),
    /http or https/
  );
  const req = resolveSearchRequest(
    { ...base, engine: "custom", custom_url: "http://127.0.0.1:9/search?q={{q}}" },
    "a b/../x"
  );
  const url = new URL(req.url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.searchParams.get("q"), "a b/../x");
});

test("local searx http is allowed", () => {
  const req = resolveSearchRequest(
    { ...base, engine: "searx", searx_url: "http://127.0.0.1:8080/" },
    "hello"
  );
  assert.equal(req.url, "http://127.0.0.1:8080/search?q=hello&format=json");
});
