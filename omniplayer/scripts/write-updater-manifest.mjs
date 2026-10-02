#!/usr/bin/env node
/**
 * Write the static latest.json Tauri's updater reads from a GitHub Release.
 * The signature is the full text of the bundler's .sig file (not a URL).
 *
 *   node scripts/write-updater-manifest.mjs \
 *     --version 0.1.5 \
 *     --signature-file dist/Liuhen-0.1.5-windows-x64-setup.exe.sig \
 *     --url https://github.com/Fortda/liuhen/releases/download/v0.1.5/Liuhen-0.1.5-windows-x64-setup.exe \
 *     --out dist/latest.json
 *
 *   node scripts/write-updater-manifest.mjs --self-test
 */

import { readFileSync, writeFileSync } from "node:fs";

export function buildUpdaterManifest({
  version,
  notes,
  pubDate,
  signature,
  url,
}) {
  const ver = String(version || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+/.test(ver)) {
    throw new Error(`version must be semver, got ${JSON.stringify(version)}`);
  }
  const sig = String(signature || "").trim();
  if (!sig || sig.includes("REPLACE_WITH")) {
    throw new Error("signature file is empty");
  }
  const assetUrl = String(url || "").trim();
  if (!assetUrl.startsWith("https://github.com/Fortda/liuhen/releases/download/")) {
    throw new Error("url must be a Fortda/liuhen GitHub Release download");
  }
  const platform = { signature: sig, url: assetUrl };
  return {
    version: ver,
    notes: notes || "",
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": platform,
      "windows-x86_64-nsis": platform,
    },
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return "";
  return process.argv[i + 1];
}

function selfTest() {
  const manifest = buildUpdaterManifest({
    version: "v0.1.6",
    notes: "full nsis",
    pubDate: "2026-10-02T00:00:00.000Z",
    signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNpZ25lcgo=",
    url: "https://github.com/Fortda/liuhen/releases/download/v0.1.6/Liuhen-0.1.6-windows-x64-setup.exe",
  });
  if (manifest.version !== "0.1.6") throw new Error("version strip failed");
  if (manifest.platforms["windows-x86_64"].url !== manifest.platforms["windows-x86_64-nsis"].url) {
    throw new Error("platform urls diverged");
  }
  if (!manifest.platforms["windows-x86_64"].signature.startsWith("dW50")) {
    throw new Error("signature dropped");
  }
  let threw = false;
  try {
    buildUpdaterManifest({
      version: "0.1.6",
      notes: "",
      pubDate: "2026-10-02T00:00:00.000Z",
      signature: "abc",
      url: "https://evil.example/setup.exe",
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("foreign url was accepted");
  console.log("write-updater-manifest self-test ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const version = arg("--version");
  const signature = readFileSync(arg("--signature-file"), "utf8");
  const url = arg("--url");
  const notes = arg("--notes");
  const pubDate = arg("--pub-date") || new Date().toISOString();
  const manifest = buildUpdaterManifest({ version, notes, pubDate, signature, url });
  const out = arg("--out");
  if (!out) throw new Error("--out is required");
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(out);
}
