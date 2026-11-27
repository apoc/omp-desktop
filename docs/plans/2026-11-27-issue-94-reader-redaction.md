# Issue #94: redact chunked and unparsable agent lines

Decision record for `fix/reader-redaction`. Base: master `88206e0`.

## Problem (verified)

`src-tauri/src/agent/reader.rs` `sanitize_line` redacts only lines `serde_json` parses.

- Protocol-v2 `rpc_chunk` envelopes parse, but the logical frame is base64 in `data`, so nothing in it is redacted. Every chunk is journaled and emitted, and `live.js` reassembles the frame afterwards, live and on replay.
- A line serde rejects (e.g. an escaped lone surrogate `\ud800`, which `JSON.parse` accepts) is journaled and emitted as raw bytes.
- Every Rust consumer also misses chunked frames, because they see `type: "rpc_chunk"`: the remote tracker, auto-approval and `approvals::observe`, `ext_ui`, `inflight`, and the widgets' `turn_end` trigger.

omp's facts (`oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-frame.ts`):

- Chunking happens only under protocol v2, for a frame of 1 MiB or more.
- Each chunk carries at most 256 KiB of raw payload, and a reassembled frame is at most 64 MiB.
- The shape is `{type:"rpc_chunk", chunkId, index, count, byteLength, data}`, with `data` in standard padded base64.
- A run is emitted in order and never interleaved with other frames. omp's own client rejects interruptions (`RpcFrameDecoder`, around line 196).

## Decisions

- **D94-1 Rust reassembles.** A pure assembler module in `src-tauri/src/agent/` (its own file, with unit tests) rebuilds a chunk run in the reader thread before any consumer sees it. Its validation mirrors omp's `RpcFrameDecoder` check for check (cite the omp lines in the module doc):
  - `chunkId` is a string within omp's length bound.
  - `count` is within omp's bounds.
  - Indexes start at 0 and are sequential.
  - `chunkId`, `count` and `byteLength` match across the run.
  - `byteLength` is within omp's bounds.
  - `data` is strict base64, and each decoded chunk is at most 256 KiB.
  - The running total never exceeds `byteLength`, and the final total equals it.
  - The partial buffer never grows past `byteLength` (64 MiB cap). Do not preallocate `byteLength` up front from frame metadata; grow as chunks arrive.
- **D94-2 One logical frame, one pipeline pass.** The reassembled bytes run through exactly the same per-line steps as a physical line, in the existing order: sanitize, auto-approve/track, tracker, journal, `ext_ui`, emit, widgets `turn_end`, `inflight`, `saw_frame`. The chunk envelope lines themselves are never journaled or emitted. One logical frame gets one journal seq. The 16 MiB physical-line cap is unchanged.
- **D94-3 Failures become a fixed diagnostic frame.** These all drop the partial run:
  - a chunk failing validation;
  - a non-chunk line arriving while a run is open;
  - EOF with an open run;
  - a reassembled payload that is not UTF-8, not JSON, or not a JSON object.

  The reader then journals and emits one `{"type":"desktop_frame_error","reason":"<fixed token>"}` frame. It carries no raw bytes, no chunk data and no ids. Tokens: `chunk_invalid`, `chunk_interrupted`, `unparsable`. A non-chunk line that interrupts a run is processed normally after the diagnostic. A diagnostic is not a frame for `saw_frame` (the stderr fallback for a silent startup death is unchanged).
- **D94-4 Lone surrogates are repaired, not dropped.** When serde rejects a line, the reader runs one escape-aware pass: inside JSON strings, every `\uD800`–`\uDFFF` escape that is not part of a valid high+low pair is rewritten to `\uFFFD`. An escaped backslash (`\\ud800`) is literal text and is left alone. Then it parses again. Success gives a normal frame, sanitized and re-serialized from the parsed value. Still invalid gives D94-3 `unparsable`. The same pass applies to reassembled payloads.
- **D94-5 The webview loses its reassembler.** Rust never forwards `rpc_chunk` any more, so `live.js`'s chunk accumulator and `reassembleRpcChunks` are removed (clean cutover). The shared base64 helper stays if the terminal uses it. `_dispatchFrame` ignores `desktop_frame_error` with one `console.warn` per frame and no UI. The comment at `live.js` `handleLine` ("already credential-redacted") becomes true; keep it accurate.
- **D94-6 Docs.** Update:
  - the AGENTS.md repo-map entry for `agent/` (`reader.rs` gains chunk reassembly and the diagnostic frame);
  - any architecture doc or module header claiming chunked frames are invisible to Rust (`ext_ui.rs` header, `turn-status.md`, `extension-widgets.md`; grep `rpc_chunk`/`chunk`);
  - CHANGELOG `[Unreleased]` → `### Fixed`.

## Tests (required)

- Assembler: each validation rule on both sides, out-of-order index, interruption, oversize chunk, a total above or below `byteLength`, non-object payload.
- Reader pipeline, through the pure per-line seam (extract one if needed; no omp process):
  - a chunked frame whose JSON holds `apiKey` comes out as one journal entry, redacted, with no base64 of the secret in any emitted or journaled text;
  - a chunked `extension_ui_request` select prompt reaches the tracker and `approvals::observe`.
- Surrogate repair: lone high, lone low, a valid pair kept, `\\ud800` untouched, repair inside a reassembled payload.
- Unparsable line: the diagnostic frame only, with no raw bytes; `saw_frame` is unaffected.
- JS: a regression test that a `desktop_frame_error` frame is ignored, if a `live.js` harness covers `_dispatchFrame` (`tests/test-pr-automation-bridge.mjs` loads `live.js` with stubs).

## Amendments (review round 1)

- **D94-7 Deep frames are parsed, within a ceiling.** serde_json refuses anything nested more than 128 levels. omp and `JSON.parse` accept such frames, and a model can produce them: a deeply nested tool-call argument is echoed in `message_end`, then in every later `get_messages`. Turning these into `unparsable` would hide a message and break history loading for that session. So:
  - A line or payload that serde rejects gets one string-aware depth scan. This runs on the failure path only, never per line.
  - When the maximum depth is between 129 and `MAX_FRAME_DEPTH` (1024), it is parsed again with serde_json's `unbounded_depth` feature (`Deserializer::disable_recursion_limit`).
  - Deeper than that, or still invalid, gives `unparsable`, as D94-3 says.
  - The reader thread is spawned with an explicit stack size large enough for parse, `sanitize_frame` and `Value` drop at `MAX_FRAME_DEPTH`. A test runs that worst case on a thread of the same size.
  - The surrogate repair and the depth retry compose: repair, then the depth retry.
- **D94-8 Contract docs say "logical frame".** The following now describe one event or entry per logical frame, sized up to 64 MiB (`MAX_REASSEMBLED_BYTES`):
  - `AgentBridge`'s `# Events` doc, `LineEvent`, the `agent/mod.rs` submodule list (add `frames`) and the journal budget reasoning (`mod.rs` `EVENT_JOURNAL_MAX_BYTES`, `journal.rs`);
  - `inflight.rs`'s per-line hook.
