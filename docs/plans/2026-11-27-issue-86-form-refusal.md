# Issue #86: an ask form is cancelled within milliseconds and aborts the turn

Decision record for `fix/86-form-refusal`. Base: master `137815f`.

## Problem (verified)

- In v0.15.2 (the release the report was made against) `live.js` had no branch for `extension_ui_request` `method: "form"` (omp 19.1+). The request fell into the catch-all for unknown methods, which answers `{cancelled: true}` at once. omp's ask tool reads a cancellation as the user's (`tools/ask.ts` `cancelAsk`: `context.abort()`, `"Ask tool was cancelled by the user"`), so the whole turn ended a few milliseconds after the form request. That is the reported 30–60 ms, the missing card and the aborted session.
- PR #93 (merged as `137815f`) renders forms, so a readable form (the reported one: a fieldset with two radios and ~1.8 KB of Chinese `<p>`/`<b>`/`<ul>`/`<code>` text) is now shown and answerable. Checked: a form of that shape parses into one two-option choice field.
- Still open: every form the desktop itself refuses — unreadable, over a parser limit, or carrying the password marker — is answered with `{cancelled: true}` at once, and so still aborts the whole turn in the same few milliseconds. The bubble's Retry resends the same cancellation.
- The CHANGELOG line for #93 says "before, the tab waited forever"; it was cancelled at once instead.

Measured against omp 19.2.1 (`/tmp` RPC probe, `--mode rpc-ui`, form request answered in ~1 ms):

|Reply|ask tool result|Turn|
|---|---|---|
|`{cancelled: true}`|error `Ask tool was cancelled by the user`|aborted (`stopReason: "aborted"`, no reply)|
|`{data: {"<reason sentence>": null}}`|error `Form dialog data carries unknown field "<reason sentence>"`|continues; the model read the reason and asked in plain text|

omp's `parseFormDialogResponse` rejects an unknown name before it looks at any value (same check at v19.1.0 and v19.2.1); the throw reaches the agent loop as an ordinary tool error. omp's response union has no other non-cancelling variant.

## Decisions

- **D86-1 A refusal is not a cancellation.** A form request the desktop refuses (no `form` from `OMP_HTML_FORM.parse`: unreadable, a limit, the password marker) is answered with `{data: {<refusal sentence>: null}}`, never `{cancelled: true}`. omp then fails only that ask call with an error carrying the sentence, and the turn goes on. The user's own Cancel on a shown form stays `{cancelled: true}` (omp's Esc meaning: stop the turn). omp's `cancel` withdrawal handling is unchanged. The catch-all for unknown methods and the `ask` method's unparseable-question cancel are out of scope (no response shape omp would read as a reason).
- **D86-2 The sentence is built in one place.** A pure `OMP_HTML_FORM.refusalData(error)` in `src/app/html-form.js` returns that one-key object. The sentence is English, for the model, never passed to `OMP_TR`:
  - password marker refusal: `OMP Desktop does not show ask forms that mention a password. Do not ask for a password in the chat or in a form; if one is needed, tell the user to enter it in a terminal. Ask anything else in plain text.`
  - any other refusal: `OMP Desktop could not show this ask form: <reason> Do not send this form again; ask the user in plain text instead.`, with `<reason>` the parse error filled in by `OMP_HTML_FORM.errorText` (English source text with its vars).
  The password case is recognised from the parse error itself (the parser's password refusal), not by searching the HTML again.
- **D86-3 Retry resends the refusal.** The unsupported-form bubble's Retry (desktop and phone, both through `OMP_BRIDGE.cancelAsk`) sends the same refusal data for a form bubble that has no parsed `form`. The failed-delivery note on that bubble reads `The refusal could not be delivered to omp.` instead of the cancellation wording.
- **D86-4 The collapsed summary says `not shown`.** A settled form bubble without a parsed `form` that omp did not withdraw collapses with status `not shown` (negative, like `cancelled`), not `cancelled`: the turn was not cancelled. `closed by omp` still wins. New source string `not shown` gets its `i18n-zh.js` entry (`未显示`).
- **D86-5 Docs.** `docs/architecture/ask-dialog.md` (HTML forms section: the refusal reply, why it is not a cancellation, Retry) and `CHANGELOG.md` `[Unreleased]`: correct the #93 line's "before, the tab waited forever" to what happened (cancelled at once, which ended the turn, #86), and a `Fixed` entry: a form the desktop cannot show no longer ends the turn; omp tells the agent why, and the agent can ask in plain text.
