#!/usr/bin/env node
// Regression script for .github/scripts/updater-json.mjs — how the release
// workflow maps signed release assets onto tauri-plugin-updater platform
// keys, and the guards that keep a broken or mislabelled release from
// publishing a feed.
// Run: node test-updater-json.mjs  (or: npm run test:updater-json)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlatforms, changelogSection, keysFor, versionMismatch,
} from "./.github/scripts/updater-json.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), ".github/scripts/updater-json.mjs");

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

// Exactly the signed assets tauri-action uploaded in the v0.3.1-rc.1 dry run
// (GitHub turns the spaces in "OMP Desktop" into dots).
const ASSETS = [
  "OMP.Desktop-0.3.0-1.x86_64.rpm",
  "OMP.Desktop_0.3.0_amd64.AppImage",
  "OMP.Desktop_0.3.0_amd64.deb",
  "OMP.Desktop_0.3.0_x64-setup.exe",
  "OMP.Desktop_0.3.0_x64_en-US.msi",
  "OMP.Desktop_aarch64.app.tar.gz",
  "OMP.Desktop_x64.app.tar.gz",
];
const artifacts = (names) => names.map((name) => ({ name, signature: `sig:${name}` }));
const assetOf = (platforms, key) => decodeURIComponent(platforms[key].url.split("/").pop());

check("every key the plugin may look up resolves to the right artifact", () => {
  const { platforms, missing } = buildPlatforms(artifacts(ASSETS), "apoc/omp-desktop", "v0.3.0");
  assert.deepEqual(missing, []);
  const got = Object.fromEntries(Object.keys(platforms).sort().map((k) => [k, assetOf(platforms, k)]));
  assert.deepEqual(got, {
    "darwin-aarch64": "OMP.Desktop_aarch64.app.tar.gz",
    "darwin-aarch64-app": "OMP.Desktop_aarch64.app.tar.gz",
    "darwin-x86_64": "OMP.Desktop_x64.app.tar.gz",
    "darwin-x86_64-app": "OMP.Desktop_x64.app.tar.gz",
    // The bare key is the fallback for an unknown bundle type: it must be a
    // bundle that can replace itself, never the .deb.
    "linux-x86_64": "OMP.Desktop_0.3.0_amd64.AppImage",
    "linux-x86_64-appimage": "OMP.Desktop_0.3.0_amd64.AppImage",
    "linux-x86_64-deb": "OMP.Desktop_0.3.0_amd64.deb",
    "linux-x86_64-rpm": "OMP.Desktop-0.3.0-1.x86_64.rpm",
    "windows-x86_64": "OMP.Desktop_0.3.0_x64_en-US.msi",
    "windows-x86_64-msi": "OMP.Desktop_0.3.0_x64_en-US.msi",
    "windows-x86_64-nsis": "OMP.Desktop_0.3.0_x64-setup.exe",
  });
  assert.equal(platforms["linux-x86_64"].signature, "sig:OMP.Desktop_0.3.0_amd64.AppImage");
});

check("URLs point at the tag's download path with the name encoded", () => {
  const { platforms } = buildPlatforms(artifacts(["My App_0.1.0_amd64.AppImage"]), "o/r", "v0.1.0");
  assert.equal(platforms["linux-x86_64"].url, "https://github.com/o/r/releases/download/v0.1.0/My%20App_0.1.0_amd64.AppImage");
});

check("a missing macOS leg is reported, not papered over", () => {
  const { missing } = buildPlatforms(artifacts(ASSETS.filter((n) => !n.includes("aarch64"))), "o/r", "v0.3.0");
  assert.deepEqual(missing, ["darwin-aarch64"]);
});

check("two artifacts claiming one key is an error", () => {
  assert.throws(
    () => buildPlatforms(artifacts(["A_0.1.0_amd64.AppImage", "B_0.1.0_amd64.AppImage"]), "o/r", "v0.1.0"),
    /two artifacts claim linux-x86_64/,
  );
});

check("unknown artifacts and names without an arch claim nothing", () => {
  assert.deepEqual(keysFor("OMP.Desktop_0.3.0_x64.dmg"), []);
  assert.deepEqual(keysFor("OMP.Desktop.app.tar.gz"), []);
});

check("changelog section stops at the next release and matches exactly", () => {
  const text = [
    "# Changelog", "", "## [0.3.10] - 2026-10-01", "", "- ten", "",
    "## [0.3.1] - 2026-09-25", "", "### Added", "", "- one", "",
    "## [0.3.0] - 2026-09-24", "", "- zero",
  ].join("\n");
  assert.equal(changelogSection(text, "0.3.1"), "### Added\n\n- one");
  assert.equal(changelogSection(text, "0.3.0"), "- zero");
  assert.equal(changelogSection(text, "0.4.0"), "");
});

check("a stable tag must match the app version; a prerelease may not", () => {
  assert.equal(versionMismatch("v0.3.1", "0.3.1"), null);
  assert.match(versionMismatch("v0.3.2", "0.3.1"), /does not match/);
  assert.equal(versionMismatch("v0.3.2-rc.1", "0.3.1"), null);
});

// The CLI path the workflow actually runs, through a symlink whose name has
// a space — the case where a naive `import.meta.url === file://argv[1]`
// entry guard silently skipped main() and emitted an empty feed.
check("run directly (via a symlink with a space), the CLI writes the feed", () => {
  const dir = mkdtempSync(join(tmpdir(), "updater-json-"));
  try {
    for (const n of ASSETS) writeFileSync(join(dir, `${n}.sig`), `sig:${n}\n`);
    const link = join(dir, "a b.mjs");
    symlinkSync(realpathSync(SCRIPT), link);
    const run = (...extra) => execFileSync(process.execPath, [link, "--sigdir", dir, "--repo", "o/r",
      "--tag", "v0.3.0", "--app-version", "0.3.0", ...extra], { encoding: "utf8", stdio: "pipe" });
    const feed = JSON.parse(run());
    assert.equal(feed.version, "0.3.0");
    assert.equal(feed.platforms["linux-x86_64"].signature, "sig:OMP.Desktop_0.3.0_amd64.AppImage");
    assert.ok(!Number.isNaN(Date.parse(feed.pub_date)), "pub_date must be a parseable timestamp");
    // Strict flags: a typo must fail, not silently drop the release notes.
    assert.throws(() => run("--change-log", "CHANGELOG.md"), /Unknown option/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`test-updater-json: ${passed} checks passed`);
