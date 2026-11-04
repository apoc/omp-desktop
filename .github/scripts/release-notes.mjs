#!/usr/bin/env node
// Write the GitHub release page's body for one release: the version's
// CHANGELOG section, then the installation and requirements text.
//
// Usage:
//   node release-notes.mjs --tag <vX.Y.Z> --app-version <X.Y.Z> \
//        --changelog <CHANGELOG.md> > notes.md
//
// release.yml's `updater-json` job sets the draft's body from it (`gh release
// edit --notes-file`) once every build succeeded; tauri-action creates the
// draft without one. The body is written whole, never appended to, so a
// rerun of the job leaves the same page.
//
// The changes are the `## [X.Y.Z]` section the in-app updater shows too
// (updater-json.mjs). A stable tag without one fails: that is a release cut
// without its CHANGELOG step, and the page and the updater would both say
// nothing. A prerelease (a dry run) falls back to `## [Unreleased]`, since its
// changes aren't released under a version yet.

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { changelogSection } from "./updater-json.mjs";

const INSTALL = `### Installation
| Platform | File |
|----------|------|
| Windows  | \`.msi\` (recommended) or \`.exe\` (NSIS) |
| macOS    | \`.dmg\` |
| Linux    | \`.AppImage\` or \`.deb\` |

**Windows:** if SmartScreen blocks the installer, click _More info → Run anyway_.
This will resolve once the app is code-signed.

**Updates:** Windows, macOS and the Linux \`.AppImage\` update themselves
in-app; \`.deb\`/\`.rpm\` installs are notified and link here.

### Requirements
- [oh-my-pi](https://github.com/can1357/oh-my-pi) (\`omp\`) must be installed
  and available on your \`PATH\`.`;

/** The release body for `tag` from the changelog `text`. Throws when a
 *  stable release has no `## [appVersion]` section. */
export function releaseNotes(text, tag, appVersion) {
  const prerelease = tag.includes("-");
  const changes = changelogSection(text, appVersion) || (prerelease ? changelogSection(text, "Unreleased") : "");
  if (!changes && !prerelease) throw new Error(`CHANGELOG.md has no "## [${appVersion}]" section for ${tag}`);
  return [`## omp-desktop ${tag}`, changes, INSTALL].filter(Boolean).join("\n\n") + "\n";
}

function main() {
  const { values: a } = parseArgs({
    options: {
      tag: { type: "string" },
      "app-version": { type: "string" },
      changelog: { type: "string" },
    },
  });
  for (const k of ["tag", "app-version", "changelog"]) if (!a[k]) throw new Error(`--${k} is required`);
  process.stdout.write(releaseNotes(readFileSync(a.changelog, "utf8"), a.tag, a["app-version"]));
}

// Run only when executed directly, not when imported; see updater-json.mjs
// for why the entry point is compared as a resolved file URL.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (import.meta.url === entry) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
