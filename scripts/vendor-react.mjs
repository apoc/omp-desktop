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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: bun scripts/vendor-react.mjs <react version, e.g. 19.3.0>");
  process.exit(2);
}
const outDir = resolve(import.meta.dir, "..", "src");
const work = mkdtempSync(join(tmpdir(), "vendor-react-"));
const startDir = process.cwd();

try {
  // Without a manifest of its own, npm walks up from `work` to the first
  // ancestor holding a package.json/node_modules and installs *there*.
  writeFileSync(join(work, "package.json"), '{ "private": true }\n');
  const install = Bun.spawnSync(
    [
      "npm", "install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts",
      `react@${version}`, `react-dom@${version}`,
    ],
    { cwd: work, stdout: "inherit", stderr: "inherit" },
  );
  if (install.exitCode !== 0) throw new Error("npm install failed");
  const pkgVersion = (name) =>
    JSON.parse(readFileSync(join(work, "node_modules", name, "package.json"), "utf8")).version;
  // react, react-dom and scheduler share this exact MIT text.
  const license = readFileSync(join(work, "node_modules", "react", "LICENSE"), "utf8").trim();

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

  // `/*!` so any later minifier keeps it; Bun drops every upstream comment,
  // including the `@license` headers, so the notices are restated here.
  const banner = (what, extraNotices) =>
    [
      `/*! ${what} ${version} (development build), bundled from the official npm`,
      `packages (scheduler ${pkgVersion("scheduler")}) by scripts/vendor-react.mjs with Bun ${Bun.version}.`,
      "Do not edit; regenerate instead.",
      "",
      ...license.split("\n"),
      ...extraNotices,
    ]
      .map((line, i) => (i === 0 ? line : line ? ` * ${line}` : " *"))
      .join("\n") + "\n */";

  // Bun labels each module with its path relative to cwd: build from inside
  // `work` so the labels read `node_modules/…` and a re-run is byte-identical.
  process.chdir(work);
  for (const [entry, file, what, plugins, extraNotices] of [
    ["react-entry.js", "react.development.js", "React", [], []],
    [
      "react-dom-entry.js", "react-dom.development.js", "ReactDOM", [reactFromGlobal],
      ["", "Includes Modernizr 3.0.0pre (Custom Build) | MIT"],
    ],
  ]) {
    // Bun.build throws (an AggregateError of its logs) on failure.
    const result = await Bun.build({
      entrypoints: [join(work, entry)],
      format: "iife",
      target: "browser",
      minify: false,
      define: { "process.env.NODE_ENV": '"development"' },
      plugins,
    });
    const code = await result.outputs[0].text();
    if (code.includes(work) || code.includes("vendor-react-")) {
      throw new Error(`${file}: a temp path leaked into the bundle`);
    }
    writeFileSync(join(outDir, file), `${banner(what, extraNotices)}\n${code}`);
    console.log(`wrote src/${file} (${code.length} bytes)`);
  }
} finally {
  process.chdir(startDir); // Windows cannot remove the cwd
  rmSync(work, { recursive: true, force: true });
}
