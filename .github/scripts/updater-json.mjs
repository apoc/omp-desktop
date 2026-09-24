#!/usr/bin/env node
// Assemble the in-app updater feed (`latest.json`) for one release from the
// `.sig` files the build jobs uploaded next to their installers.
//
// Runs once, after every build job has finished (release.yml's
// `updater-json` job). The build jobs deliberately don't write the feed
// themselves: four parallel jobs read-modify-writing one release asset race,
// and a lost update silently drops a platform from the feed.
//
// Usage:
//   node updater-json.mjs --sigdir <dir> --repo <owner/name> --tag <vX.Y.Z> \
//        --app-version <X.Y.Z> [--changelog <CHANGELOG.md>] > latest.json
//
// The feed's `version` is `--app-version` (tauri.conf.json), not the tag:
// it must equal what the published binaries report. A stable tag that
// disagrees with it is an error — that is a forgotten version bump, and
// the feed would announce the old version, so installs already on it
// would never be offered this release. A prerelease tag is allowed
// through, since releases/latest/ never serves a prerelease's feed.
//
// Release notes are the `## [X.Y.Z]` section of the changelog, if any.
// <dir> holds the downloaded `*.sig` assets, named exactly as on the
// release (GitHub turns the spaces in "OMP Desktop" into dots). Each
// signature's artifact is the same name without `.sig`.
//
// Fails (exit 1) when a platform the app ships to has no signed artifact,
// so a broken build can never publish a feed that strands those users.

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Platform keys every release must cover — see tauri-plugin-updater's
 *  `{os}-{arch}` fallback lookup. */
export const REQUIRED = ["linux-x86_64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"];

const ARCH = { amd64: "x86_64", x64: "x86_64", x86_64: "x86_64", aarch64: "aarch64", arm64: "aarch64" };

function archOf(name) {
  const m = name.match(/[_.-](amd64|x64|x86_64|aarch64|arm64)[_.-]/);
  return m ? ARCH[m[1]] : null;
}

/**
 * Updater platform keys an artifact serves, most specific last. The plugin
 * looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`; the bare key
 * is what an install of unknown bundle type (and every older client)
 * resolves to, so it goes to the self-updating bundle of each OS: the
 * AppImage (a .deb can't replace itself), the MSI (the recommended Windows
 * installer), the .app archive.
 */
export function keysFor(name) {
  const arch = archOf(name);
  if (!arch) return [];
  if (name.endsWith(".AppImage")) return [`linux-${arch}`, `linux-${arch}-appimage`];
  if (name.endsWith(".deb")) return [`linux-${arch}-deb`];
  if (name.endsWith(".rpm")) return [`linux-${arch}-rpm`];
  if (name.endsWith(".msi")) return [`windows-${arch}`, `windows-${arch}-msi`];
  if (name.endsWith("-setup.exe")) return [`windows-${arch}-nsis`];
  if (name.endsWith(".app.tar.gz")) return [`darwin-${arch}`, `darwin-${arch}-app`];
  return [];
}

/** `{ platforms, missing }` from `[{ name, signature }]` artifact entries. */
export function buildPlatforms(artifacts, repo, tag) {
  const platforms = {};
  for (const { name, signature } of artifacts) {
    const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
    for (const key of keysFor(name)) {
      if (platforms[key]) throw new Error(`two artifacts claim ${key}: ${platforms[key].url} and ${url}`);
      platforms[key] = { signature, url };
    }
  }
  const missing = REQUIRED.filter((k) => !platforms[k]);
  return { platforms, missing };
}

/** Body of the `## [version]` section of a Keep-a-Changelog file, or "". */
export function changelogSection(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

/** Error text when a stable `tag` disagrees with the built app version (a
 *  forgotten bump: the feed would never offer this release), else null. */
export function versionMismatch(tag, appVersion) {
  const tagVersion = tag.replace(/^v/, "");
  if (tagVersion === appVersion || tagVersion.includes("-")) return null;
  return `tag ${tag} does not match the app version ${appVersion} in tauri.conf.json`;
}

function main() {
  // Strict: an unknown or valueless flag is an error, not a silent default.
  const { values: a } = parseArgs({
    options: {
      sigdir: { type: "string" },
      repo: { type: "string" },
      tag: { type: "string" },
      "app-version": { type: "string" },
      changelog: { type: "string" },
    },
  });
  for (const k of ["sigdir", "repo", "tag", "app-version"]) if (!a[k]) throw new Error(`--${k} is required`);
  const mismatch = versionMismatch(a.tag, a["app-version"]);
  if (mismatch) throw new Error(mismatch);
  const artifacts = readdirSync(a.sigdir)
    .filter((f) => f.endsWith(".sig"))
    .map((f) => ({ name: f.slice(0, -4), signature: readFileSync(join(a.sigdir, f), "utf8").trim() }));
  const { platforms, missing } = buildPlatforms(artifacts, a.repo, a.tag);
  if (missing.length) {
    throw new Error(`no signed artifact for: ${missing.join(", ")} ` +
      `(signatures found: ${artifacts.map((x) => x.name).join(", ") || "none"})`);
  }
  const feed = {
    version: a["app-version"],
    notes: a.changelog ? changelogSection(readFileSync(a.changelog, "utf8"), a["app-version"]) : "",
    pub_date: new Date().toISOString(),
    platforms,
  };
  process.stdout.write(JSON.stringify(feed, null, 2) + "\n");
}

// Run only when executed directly, not when imported (test-updater-json.mjs).
// Node resolves the entry point's symlinks and percent-encodes its URL, so
// compare like with like — a raw `file://${argv[1]}` never matches a path
// with a space, a symlink or a Windows drive, and `main()` would silently
// not run, leaving an empty feed.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (import.meta.url === entry) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
