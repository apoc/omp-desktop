#!/usr/bin/env node
// Regenerates the vendored xterm.js files in src/ from the official npm
// packages, once, at vendoring time (nothing installs them for a build):
//
//   node scripts/vendor-xterm.mjs 6.0.0 0.11.0 0.12.0
//                                 ^@xterm/xterm ^@xterm/addon-fit ^@xterm/addon-web-links
//
// - src/xterm.js                  ← @xterm/xterm/lib/xterm.js          (UMD → window.Terminal)
// - src/xterm.css                 ← @xterm/xterm/css/xterm.css
// - src/xterm-addon-fit.js        ← @xterm/addon-fit/lib/addon-fit.js  (UMD → window.FitAddon)
// - src/xterm-addon-web-links.js  ← @xterm/addon-web-links/lib/addon-web-links.js (UMD → window.WebLinksAddon)
//
// Copied as is, apart from two changes to the three .js files: the trailing
// `//# sourceMappingURL=…` comment goes (the .map files are not vendored, so
// the webview would request a missing file, and the release CSP would have
// to cover it), and a `/*!` banner with the package, its version and its MIT
// license is prepended — the minified builds carry no notice of their own
// (xterm.css keeps its upstream header). Never hand-edit the outputs; re-run
// this script with the new versions instead.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [xtermVersion, fitVersion, webLinksVersion] = process.argv.slice(2);
const semver = /^\d+\.\d+\.\d+$/;
if (![xtermVersion, fitVersion, webLinksVersion].every((version) => semver.test(version ?? ""))) {
  console.error("usage: node scripts/vendor-xterm.mjs <@xterm/xterm version> <@xterm/addon-fit version> <@xterm/addon-web-links version>, e.g. 6.0.0 0.11.0 0.12.0");
  process.exit(2);
}
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const work = mkdtempSync(join(tmpdir(), "vendor-xterm-"));

try {
  // Without a manifest of its own, npm walks up from `work` to the first
  // ancestor holding a package.json/node_modules and installs *there*.
  writeFileSync(join(work, "package.json"), '{ "private": true }\n');
  const install = spawnSync(
    "npm",
    [
      "install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts",
      `@xterm/xterm@${xtermVersion}`, `@xterm/addon-fit@${fitVersion}`,
      `@xterm/addon-web-links@${webLinksVersion}`,
    ],
    // npm is a .cmd shim on Windows, which only a shell can run.
    { cwd: work, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (install.status !== 0) throw new Error("npm install failed");
  const pkgDir = (name) => join(work, "node_modules", name);
  const pkgVersion = (name) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8")).version;

  // `/*!` so any later minifier keeps it.
  const banner = (name) =>
    [
      `/*! ${name} ${pkgVersion(name)}, copied from the official npm package by`,
      "scripts/vendor-xterm.mjs (sourcemap comment removed). Do not edit; regenerate instead.",
      "",
      ...readFileSync(join(pkgDir(name), "LICENSE"), "utf8").trim().split("\n"),
    ]
      .map((line, i) => (i === 0 ? line : line ? ` * ${line}` : " *"))
      .join("\n") + "\n */\n";

  const sourceMapComment = /\n?\/\/# sourceMappingURL=\S+\s*$/;
  // Read in full before anything is written: a failed run leaves src/ as it was.
  const outputs = [
    ["@xterm/xterm", "lib/xterm.js", "xterm.js", true],
    ["@xterm/xterm", "css/xterm.css", "xterm.css", false],
    ["@xterm/addon-fit", "lib/addon-fit.js", "xterm-addon-fit.js", true],
    ["@xterm/addon-web-links", "lib/addon-web-links.js", "xterm-addon-web-links.js", true],
  ].map(([name, from, to, js]) => {
    const text = readFileSync(join(pkgDir(name), from), "utf8");
    return [`${name}/${from}`, to, js ? banner(name) + text.replace(sourceMapComment, "\n") : text];
  });
  for (const [from, to, text] of outputs) {
    writeFileSync(join(outDir, to), text);
    console.log(`src/${to} ← ${from} (${text.length} bytes)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
