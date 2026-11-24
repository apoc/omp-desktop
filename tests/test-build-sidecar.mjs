#!/usr/bin/env node
// Regression script for scripts/build-sidecar.mjs — the pure parts of the
// persona sidecar build: `rustc -vV` triple parsing, Tauri's externalBin
// file name and the `--target` argument.
// Run: node tests/test-build-sidecar.mjs  (or: npm run test:build-sidecar)

import assert from "node:assert/strict";
import {
  checkBuildResult,
  parseHostTriple,
  sidecarFileName,
  targetFromArgs,
  targetTriple,
} from "../scripts/build-sidecar.mjs";

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

const RUSTC = [
  "rustc 1.99.1 (8d1b8f2c3 2026-11-02)",
  "binary: rustc",
  "commit-hash: 8d1b8f2c3a5c4b3d2e1f0a9b8c7d6e5f4a3b2c1d",
  "commit-date: 2026-11-02",
  "host: aarch64-apple-darwin",
  "release: 1.99.1",
  "LLVM version: 21.1.0",
  "",
].join("\n");

check("host triple comes from the host: line", () => {
  assert.equal(parseHostTriple(RUSTC), "aarch64-apple-darwin");
});

check("CRLF output parses", () => {
  assert.equal(parseHostTriple(RUSTC.replace(/\n/g, "\r\n")), "aarch64-apple-darwin");
});

check("missing host line is an error", () => {
  assert.throws(() => parseHostTriple("rustc 1.99.1 (no host line)"), /no host: line/);
});

check("an unusable triple is an error", () => {
  assert.throws(() => parseHostTriple("host: ../evil"), /unusable host triple/);
});

check("externalBin names carry the triple and the Windows suffix", () => {
  assert.equal(sidecarFileName("aarch64-apple-darwin", "darwin"), "omp-desktopd-aarch64-apple-darwin");
  assert.equal(sidecarFileName("x86_64-unknown-linux-gnu", "linux"), "omp-desktopd-x86_64-unknown-linux-gnu");
  assert.equal(
    sidecarFileName("x86_64-pc-windows-msvc", "win32"),
    "omp-desktopd-x86_64-pc-windows-msvc.exe",
  );
});

check("--target accepts both spellings", () => {
  assert.equal(targetFromArgs(["--target", "x86_64-apple-darwin"]), "x86_64-apple-darwin");
  assert.equal(targetFromArgs(["--target=aarch64-unknown-linux-gnu"]), "aarch64-unknown-linux-gnu");
  assert.equal(targetFromArgs([]), null);
  assert.equal(targetFromArgs(["--release"]), null);
});

check("--target without a value is an error", () => {
  assert.throws(() => targetFromArgs(["--target"]), /needs a triple/);
});

check("a terminated cargo build reports its signal", () => {
  assert.throws(
    () => checkBuildResult({ status: null, signal: "SIGTERM" }),
    /cargo build killed by SIGTERM/,
  );
});

check("an explicit target does not invoke rustc", () => {
  assert.equal(
    targetTriple("x86_64-apple-darwin", () => {
      throw new Error("rustc must not run");
    }),
    "x86_64-apple-darwin",
  );
  assert.equal(targetTriple(null, () => "aarch64-apple-darwin"), "aarch64-apple-darwin");
});

console.log(`${passed} checks passed`);
