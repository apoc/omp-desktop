#!/usr/bin/env bun
// Regenerates src/react.development.js + src/react-dom.development.js.
//
// React 19 no longer publishes UMD builds, and the app loads React through
// plain <script> tags (no bundler — see CLAUDE.md), so the two globals are
// built here from the official npm packages, once, at vendoring time:
//
//   bun scripts/vendor-react.mjs 19.3.0
//
// - src/react.development.js      → window.React
// - src/react-dom.development.js  → window.ReactDOM (react-dom + react-dom/client)
//
// react-dom resolves `react` to the window.React the first file defined, so
// there is exactly one React instance (two copies break hooks). Development
// builds, matching what the app has always shipped.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: bun scripts/vendor-react.mjs <react version, e.g. 19.3.0>");
  process.exit(2);
}
const outDir = resolve(import.meta.dir, "..", "src");
const work = mkdtempSync(join(tmpdir(), "vendor-react-"));

try {
  const install = Bun.spawnSync(
    ["npm", "install", "--no-save", "--no-audit", "--no-fund", `react@${version}`, `react-dom@${version}`],
    { cwd: work, stdout: "inherit", stderr: "inherit" },
  );
  if (install.exitCode !== 0) throw new Error("npm install failed");

  // ESM entries: Bun wraps a CommonJS entry in a lazy module that nothing
  // ever calls, so the global assignment would never run.
  writeFileSync(join(work, "react-entry.js"), "import React from 'react';\nwindow.React = React;\n");
  writeFileSync(
    join(work, "react-dom-entry.js"),
    "import dom from 'react-dom';\nimport client from 'react-dom/client';\n" +
      "window.ReactDOM = { ...dom, ...client };\n",
  );

  // `react` inside the react-dom bundle → the global the first bundle set.
  const reactFromGlobal = {
    name: "react-from-global",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "global-react" }));
      build.onLoad({ filter: /.*/, namespace: "global-react" }, () => ({
        contents: "module.exports = window.React;",
        loader: "js",
      }));
    },
  };

  const banner = (what) =>
    `/**\n * ${what} ${version} (development build), bundled from the official npm\n` +
    ` * package by scripts/vendor-react.mjs. Do not edit; regenerate instead.\n` +
    ` * @license MIT — Copyright (c) Meta Platforms, Inc. and affiliates.\n */`;

  for (const [entry, file, what, plugins] of [
    ["react-entry.js", "react.development.js", "React", []],
    ["react-dom-entry.js", "react-dom.development.js", "ReactDOM", [reactFromGlobal]],
  ]) {
    const result = await Bun.build({
      entrypoints: [join(work, entry)],
      format: "iife",
      target: "browser",
      minify: false,
      define: { "process.env.NODE_ENV": '"development"' },
      plugins,
    });
    if (!result.success) throw new AggregateError(result.logs, `bundling ${file} failed`);
    // Bun labels each module with its path relative to cwd, which runs
    // through the random temp dir; strip it so a re-run is byte-identical.
    const code = (await result.outputs[0].text()).replace(/^(\s*\/\/ )\S*?vendor-react-[^/]+\//gm, "$1");
    writeFileSync(join(outDir, file), `${banner(what)}\n${code}`);
    console.log(`wrote src/${file} (${code.length} bytes)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
