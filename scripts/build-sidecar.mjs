#!/usr/bin/env node
// Builds the persona service `omp-desktopd` and stages it where Tauri's
// `bundle.externalBin` expects it (src-tauri/tauri.dist.conf.json):
//
//   node scripts/build-sidecar.mjs [--target <triple>]
//
// The staged name is `src-tauri/binaries/omp-desktopd-<triple>[.exe]`;
// `tauri build` copies it into the bundle next to the app executable under
// its plain name, which is where `persona::sidecar::path()` looks. In
// `tauri dev` the app runs from `src-tauri/target/debug/`, so that same
// lookup finds `target/debug/omp-desktopd` once
// `cargo build -p omp-desktopd` has run there.
//
// Target precedence: `--target <triple>`, then `TAURI_ENV_TARGET_TRIPLE`
// (set by the Tauri CLI for `beforeBuildCommand`, and the reason a release
// matrix job cross-building macOS x64 stages the x64 sidecar), then the
// `host:` triple of `rustc -vV`.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "src-tauri");

/** The `host:` triple printed by `rustc -vV`. */
export function parseHostTriple(versionOutput) {
  const line = versionOutput
    .split(/\r?\n/)
    .find(text => text.startsWith("host: "));
  if (!line) throw new Error("rustc -vV printed no host: line");
  const triple = line.slice("host: ".length).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(triple)) {
    throw new Error(`rustc -vV printed an unusable host triple: ${JSON.stringify(triple)}`);
  }
  return triple;
}

/** Tauri's externalBin file name for `triple` on `platform`. */
export function sidecarFileName(triple, platform = process.platform) {
  return `omp-desktopd-${triple}${platform === "win32" ? ".exe" : ""}`;
}

/** `--target <value>` / `--target=<value>` from argv, if present. */
export function targetFromArgs(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--target") {
      if (index + 1 >= args.length) throw new Error("--target needs a triple");
      return args[index + 1];
    }
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
  }
  return null;
}

function rustcHostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot run rustc: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`rustc -vV failed: ${(result.stderr ?? "").trim()}`);
  }
  return parseHostTriple(result.stdout);
}

export function targetTriple(requested, hostTriple) {
  return requested ?? hostTriple();
}

export function checkBuildResult(build) {
  if (build.signal) throw new Error(`cargo build killed by ${build.signal}`);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

function main() {
  const requested = targetFromArgs(process.argv.slice(2))
    ?? (process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || null);
  const triple = targetTriple(requested, rustcHostTriple);

  const args = ["build", "--release", "-p", "omp-desktopd"];
  if (requested) args.push("--target", triple);
  console.log(`[sidecar] cargo ${args.join(" ")}`);
  // Inherit stdio: cargo's own progress and errors are the useful output.
  const build = spawnSync("cargo", args, { cwd: tauri, stdio: "inherit" });
  if (build.error) throw new Error(`cannot run cargo: ${build.error.message}`);
  checkBuildResult(build);

  const exe = process.platform === "win32" ? ".exe" : "";
  const profile = requested ? join(tauri, "target", triple, "release") : join(tauri, "target", "release");
  const source = join(profile, `omp-desktopd${exe}`);
  const staged = join(tauri, "binaries", sidecarFileName(triple, process.platform));
  mkdirSync(dirname(staged), { recursive: true });
  copyFileSync(source, staged);
  console.log(`[sidecar] ${triple}: ${source} -> ${staged}`);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[sidecar] ${error.message}`);
    process.exit(1);
  }
}
