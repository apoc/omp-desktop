# Plan-Mode UI/UX Spec — OMP Desktop

> **Date:** 2026-05-09
> **Mockup:** [`design/plan-mode-mockup.html`](../../../design/plan-mode-mockup.html)
> **Surfaces touched:** `src/design/panels.jsx`, `src/design/layout.css`, `src/design/styles.css` (new utility classes), `src/app-live.jsx` (state wiring)

## Why this spec exists

OMP's built-in plan mode (`/plan` slash command, `exit_plan_mode` tool) is **interactive-only** — it is not surfaced over the RPC bridge that the desktop wraps. The Tauri renderer therefore drives the entire plan workflow at the UI layer using only the three RPC primitives the bridge exposes:

| Bridge call                | RPC payload                          | When we use it |
|----------------------------|---------------------------------------|----------------|
| `bridge.send(text)`        | `{ type: "prompt",    message }`      | submit intent → start drafting turn |
| `bridge.followUp(text)`    | `{ type: "follow_up", message }`      | submit review (loop), or approve & execute |
| `bridge.abort()`           | —                                     | abort drafting, abort running |

The only side-effect that survives a plan into execution is the agent's own `todo_write` tool: when it runs after approval, the existing `buildKanban()` adapter populates the kanban automatically, and `derivePlanPhase()` flips the panel from `running` to `done`. **No UI parsing of plan markdown is required.**

---

## 1. Phase state machine

Five phases. The panel is mounted once and switches phases internally; only `done` and `intent` are valid resting states.

```
        ┌─────────────┐  submit (⌘↵)              ┌──────────────┐
        │   intent    │ ─────────────────────────▶│   drafting   │
        │ (textarea)  │                           │ (streaming   │
        └─────────────┘ ◀─── abort & edit ─────── │  markdown)   │
                                                  └──────────────┘
                                                         │
                                                  turn_end (drafting)
                                                         ▼
        ┌─────────────┐                           ┌──────────────┐
        │   running   │ ◀── approve & execute ── │    review    │
        │  (kanban)   │                           │ (annotated   │
        └─────────────┘ ── all tasks done ──┐    │  blocks +    │
                                            │    │  comments)   │
                                            ▼    └──────────────┘
                                     ┌─────────────┐  ▲
                                     │    done     │  │ submit review (loop, n+1)
                                     │  (recap)    │  │
                                     └─────────────┘  └─ drafting (revise)
```

### Transitions

| From       | Event                                         | To         | Side effects |
|------------|-----------------------------------------------|------------|--------------|
| `intent`   | user clicks **draft plan** or presses ⌘↵      | `drafting` | `bridge.send(framing(intent))`; clear `planText`; `setIsStreaming(true)` |
| `intent`   | user clicks **cancel**                        | (closed)   | unmount panel, preserve intent text in component state |
| `drafting` | `message_update` deltas                       | `drafting` | append to `planText` |
| `drafting` | `turn_end` event                              | `review`   | `setIsStreaming(false)`, segment `planText` into blocks |
| `drafting` | user clicks **abort**                         | `intent`   | `bridge.abort()`; discard `planText`; restore intent textarea |
| `drafting` | user clicks **edit intent**                   | `intent`   | `bridge.abort()`; preserve partial `planText` as `lastDraft` (for diff/restore) |
| `review`   | user clicks **submit review**                 | `drafting` | `bridge.followUp(reviewFraming(...))`; clear `planText`; clear `annotations`; clear `overallComment`; bump `revision` |
| `review`   | user clicks **approve & execute** or ⌘↵        | `running`  | `bridge.followUp(APPROVAL_PROMPT)`; collapse review UI; switch footer to running variant |
| `running`  | `tool_execution_end` w/ `tool === "todo_write"` | `running` | `setKanban(buildKanban(...))`; `derivePlanPhase()` may flip to `done` |
| `running`  | all tasks `status === "done"`                 | `done`     | derived; no explicit transition |
| `running`  | user clicks **abort** / **pause**             | `running`  | `bridge.abort()`; show resume affordance |
| any        | user presses **Esc** or clicks scrim          | (closed)   | panel hides, internal state preserved on `<App>` |

### Resting state on close-and-reopen

When the panel closes (`Esc`, scrim click, X button), we **do not** unmount — `planOpen` toggles visibility but the `<PlanKanban>` instance and its hooks survive. Reopening returns the user to the same phase with the same `planText` / `annotations` / `intent`. Hard reset only happens on (a) a fresh `/plan` slash invocation, or (b) tab switch (which already resets per-session state via `bridge.activateSession()`).

---

## 2. Component breakdown

```
PlanKanban                        // existing, extended
├── PhasePill                     // existing, add intent + drafting variants
├── IntentPhase                   // new
├── DraftingPhase                 // new
│   ├── DraftStatusRow            // pulsing dot + shimmer + token meter
│   └── MarkdownContent (streaming) // existing — src/design/ui.jsx
├── ReviewPhase                   // new
│   ├── AnnotablePlan             // new
│   │   ├── PlanBlock × N         // new — wraps each marked.lexer token
│   │   │   ├── (rendered HTML for the block)
│   │   │   ├── BlockAddButton    // hover-revealed + on right margin
│   │   │   ├── CommentForm       // inline, when block is selected
│   │   │   └── CommentChip       // when annotation exists
│   │   └── …
│   └── ReviewFooter              // overall textarea + submit/approve
├── KanbanCol × N                 // existing, used in running + done
│   └── KanbanCard × N            // existing
└── (footer variants per phase)
```

### Why these splits

- **`IntentPhase` is its own component** because it owns the textarea draft, char-count, and ⌘↵ handler. It mounts even before any agent turn — it has no dependency on `planText`.
- **`DraftingPhase` is separate from `ReviewPhase`** even though both render markdown, because the streaming variant uses `streaming={true}` (which adds `.md-streaming` and the caret) and has no per-block affordances. Mixing them would force a conditional inside every PlanBlock.
- **`AnnotablePlan` is the centerpiece.** It owns block segmentation, the selected-block id, and the annotations map. `ReviewPhase` is mostly a wrapper that hosts the footer and lifts annotations up to `PlanKanban`.

### `AnnotablePlan` block segmentation

```js
function segmentPlan(text) {
  if (!text || !window.marked) return [{ raw: text, html: escapeHtml(text), kind: "p" }];
  const tokens = window.marked.lexer(text);   // top-level only (depth 0)
  return tokens
    .filter(t => t.type !== "space")          // skip whitespace tokens
    .map((t, i) => ({
      index: i,
      kind:  t.type,                          // "heading" | "paragraph" | "list" | "code" | "blockquote" | "hr" | "table"
      raw:   t.raw,                           // verbatim source — used in review framing
      html:  window.marked.parser([t]),       // render this single token's HTML
    }));
}
```

**Block granularity rules:**
- Each top-level marked token is one block. Lists are **one block each** (whole `<ul>`/`<ol>`); we do not split per-`<li>`. Rationale: the agent typically writes a list as a coherent unit, and the user's mental model is "comment on this list of steps", not "comment on item 3".
- Code fences are one block.
- Tables are one block.
- `hr` tokens are blocks but unannotatable (no `+` button, no hover affordance).
- Inline tokens (`em`, `strong`, `code`) are not blocks; they render inside their parent block's HTML.

**Stable indices:** when the agent regenerates a plan, the block indices reset (because the new tokens are different). Old annotations are discarded on phase transition `review → drafting`. We do not attempt to migrate annotations across revisions — the framing prompt already includes the comment text and the quoted block, so the agent has everything it needs.

---

## 3. Annotation data model

```ts
type Annotation = {
  raw:     string;   // verbatim raw from the marked token (token.raw)
  comment: string;   // user's comment, trimmed
};

// Owned in PlanKanban via React.useState
type Annotations = Record<number /* blockIndex */, Annotation>;
```

```jsx
const [annotations,  setAnnotations]  = React.useState({});
const [overallComment, setOverall]    = React.useState("");
const [selectedBlock, setSelectedBlock] = React.useState(null); // index or null
```

**Update operations:**
- Add or edit:    `setAnnotations(a => ({ ...a, [i]: { raw, comment } }))`
- Remove:         `setAnnotations(a => { const n = { ...a }; delete n[i]; return n; })`
- Clear all:      on phase transition `review → drafting`
- Read count:     `Object.keys(annotations).length`

**Persistence:** in-memory only for v1. Annotations live for the lifetime of the panel instance. Drafts are not written to disk. (Future: persist alongside session state if user reload would lose context.)

### Review framing — exactly what we send

```js
function reviewFraming(planText, annotations, overall) {
  const lineComments = Object.entries(annotations)
    .sort(([a], [b]) => Number(a) - Number(b))      // preserve plan order
    .map(([, { raw, comment }]) => {
      // quote the block, line-prefixed; > matches the markdown blockquote convention
      const quoted = raw.split("\n").map(l => `> ${l}`).join("\n");
      return `${quoted}\n→ ${comment}`;
    })
    .join("\n\n");

  const overallSection = overall.trim()
    ? `\n\nOverall: ${overall.trim()}`
    : "";

  return [
    "Please revise the plan based on this feedback.",
    "",
    lineComments && "Line comments:",
    lineComments,
    overallSection.trimStart(),
    "",
    "Provide the full revised plan in Markdown.",
  ].filter(Boolean).join("\n");
}
```

If `annotations` is empty *and* `overall` is empty, the **submit review** button is disabled — there's nothing to revise. (If the user wants to ship as-is, they use **approve & execute**.)

---

## 4. CSS classes

All new classes live in `src/design/layout.css` (composition) — none belong in `styles.css` (tokens).

| Class                   | Purpose                                                    | Notes |
|-------------------------|------------------------------------------------------------|-------|
| `.plan-intent-wrap`     | flex column body of the intent phase                       | scrolls if content overflows; fills `flex: 1` |
| `.plan-intent-card`     | the bordered textarea container                            | `:focus-within` lights the accent ring |
| `.plan-intent-textarea` | the textarea itself                                        | `min-height: 240px`, sans, no resize handle |
| `.plan-intent-meta`     | char-count + shortcut row beneath the textarea             | dashed top border |
| `.plan-intent-tips`     | 3-up grid of writing tips                                  | `grid-template-columns: repeat(3, 1fr)` |
| `.plan-draft-status`    | row above the streaming markdown — pulse + shimmer + meter | gradient wash over `--lilac` |
| `.plan-md`              | container for `<MarkdownContent>` in drafting              | adds the typing caret on the last block |
| `.plan-review-md`       | container for `AnnotablePlan` in review                    | reserves 36px right padding for the `+` margin |
| `.plan-block`           | wraps each segmented block                                 | `position: relative` so the `+` can absolute-position |
| `.plan-block.is-selected` | block currently being annotated                          | amber tint + 2px amber rule on the left edge |
| `.plan-block.has-comment` | block has a saved annotation                             | lilac 2px rule on the left edge |
| `.plan-block-add`       | the `+` button revealed on hover                           | absolute, right margin, fades in on `:hover` |
| `.plan-comment-form`    | inline annotation form                                     | amber-tinted, contains quoted block + textarea + actions |
| `.plan-comment-form .quoted` | header row showing the raw of the quoted block        | mono, ellipsis-truncated to 1 line |
| `.plan-comment-chip`    | saved annotation display below a block                     | lilac-tinted, click anywhere to edit, hover shows ✎/× |
| `.plan-review-foot`     | sticky review footer (overall textarea + buttons)          | replaces the generic `.kanban-foot` for `review` phase |
| `.plan-overall`         | overall textarea row inside the review footer              | label glyph + auto-growing textarea |
| `.plan-comment-count`   | chip in header showing `N comments`                        | hides when zero |

### Phase-pill extensions

`PhasePill` already supports `review | running | done`. Add:

| Phase      | Color           | Icon          | Label      |
|------------|-----------------|---------------|------------|
| `intent`   | `--fg-2`        | `edit`        | `intent`   |
| `drafting` | `--lilac`       | `thinking`    | `drafting` |
| `review`   | `--amber`       | `edit`        | `review`   *(existing label "draft" → renamed "review")* |
| `running`  | `--cyan`        | `play`        | `running`  *(existing)* |
| `done`     | `--accent`      | `check`       | `done`     *(existing)* |

> The existing label for `review` is `draft` — that conflicts with our new `drafting` phase. Rename to `review` to keep the vocabulary consistent.

---

## 5. `PlanKanban` prop interface

The panel currently takes `{ kanban, planMeta, onClose, mode, onApprove, onMode }`. Extended interface:

```ts
type PlanPhase = "intent" | "drafting" | "review" | "running" | "done";

interface PlanKanbanProps {
  // ── lifecycle ─────────────────────────────────────────────────────
  phase:           PlanPhase;
  onPhaseChange:   (next: PlanPhase) => void;   // replaces onMode
  onClose:         () => void;

  // ── bridge integration ───────────────────────────────────────────
  // Each is a thunk; PlanKanban builds the framed prompt internally
  // and the host wires these to bridge.send / bridge.followUp / bridge.abort.
  onSubmitIntent:  (intent: string) => void;
  onSubmitReview:  (annotations: Annotations, overall: string, planText: string) => void;
  onApprove:       () => void;
  onAbort:         () => void;

  // ── data ─────────────────────────────────────────────────────────
  planText:        string;                 // current plan markdown (streamed or final)
  isStreaming:     boolean;                // true during drafting phase
  kanban:          KanbanCol[];            // populated by todo_write after approval
  planMeta:        PlanMeta;               // header chips (branch, ask) — may be partial in early phases

  // ── persistence (optional, per-session) ──────────────────────────
  initialIntent?:  string;                 // restore intent textarea on reopen
}

interface PlanMeta {
  ask?:       string;                      // displayed under the title; absent in intent phase
  branch?:    string;                      // git branch chip
  strategy?:  string;                      // not rendered until running (only set after agent starts)
  touches?:   string[];
  estimate?:  { tokens: string; cost: string; wall: string };
  risks?:     { text: string; tone: "amber" | "rose" | "cyan" }[];
}

interface KanbanCol {
  id:    string;
  title: string;
  tone:  string;                           // CSS-var color name without the "var(--)"
  icon:  string;                           // Icon name
  tasks: Task[];
}

interface Task {
  id:     string;
  text:   string;
  status: "pending" | "in_progress" | "done";
  tool?:  keyof typeof TOOL_META;
  effort?: "S" | "M" | "L";
  file?:  string;
  reason?: string;
}
```

### Wire-up in `app-live.jsx`

```jsx
<PlanKanban
  phase={planPhase}
  onPhaseChange={setPlanPhase}
  onClose={() => setPlanOpen(false)}

  onSubmitIntent={(intent) => {
    setPlanPhase("drafting");
    setPlanText("");
    bridge.send(intentFraming(intent));
  }}
  onSubmitReview={(annotations, overall, planText) => {
    setPlanPhase("drafting");
    setPlanText("");
    bridge.followUp(reviewFraming(planText, annotations, overall));
  }}
  onApprove={() => {
    setPlanPhase("running");
    bridge.followUp(APPROVAL_PROMPT);
  }}
  onAbort={() => bridge.abort()}

  planText={planText}
  isStreaming={streaming}
  kanban={kanban}
  planMeta={planMeta}
  initialIntent={lastIntent}
/>
```

`planText` is a new bit of session state populated from `message_update` events while `phase === "drafting"`. The existing `buildKanban` is only used after approval — it never overwrites `planText`.

`derivePlanPhase` (already in `adapter.js`) is **only consulted when `phase === "running"`** to decide if we should flip to `done`. It does not see `intent`, `drafting`, or `review`.

---

## 6. Keyboard shortcuts

| Phase       | Combo                | Action                                |
|-------------|----------------------|---------------------------------------|
| any         | `Esc`                | close panel (state preserved)         |
| `intent`    | `⌘↵` / `Ctrl+↵`      | submit intent → `drafting`            |
| `intent`    | `Shift+↵`            | newline (default textarea behavior)   |
| `drafting`  | `⌘.` / `Ctrl+.`      | abort drafting                        |
| `review`    | `⌘↵` / `Ctrl+↵`      | approve &amp; execute (when no comment form is open) |
| `review`    | `⌘↵` (in comment form) | save the block comment              |
| `review`    | `Esc` (in comment form) | cancel comment form (no save)      |
| `review`    | `⌘⇧↵`                | submit review (when comments exist)   |
| `running`   | `⌘.`                 | abort agent (mirrors composer)        |

`⌘↵` precedence in review: if a comment form is focused, save the comment; otherwise approve. This is unambiguous because the form has its own focus trap.

Detection uses `e.metaKey || e.ctrlKey` to support both macOS and Windows (Tauri runs on both; Windows is primary per the workstation note).

---

## 7. Visual notes

- **Phase pill colors** match the workflow's emotional valence: lilac for "agent is thinking" (drafting), amber for "your attention required" (review), cyan for "agent is working" (running), accent-mint for "done".
- **Block hover affordance** is intentionally subtle — a +1px background lift, not a halo. A clearly-visible always-on `+` button on every paragraph would make the plan feel like a form.
- **Saved comment chips use lilac** to match the "agent strategy" semantic from the existing `.plan-strategy` panel; this signals "this is metadata between you and the agent" rather than a state warning.
- **Selected/open comment form uses amber** to match the `review` phase pill — it's the active editing state.
- **Streaming caret** matches the existing `.caret-blink` pattern (accent color, 1.05s steps), placed at the end of the last block.
- **No glassmorphism, no gradient text, no decorative icons.** The only gradients are the existing aurora wash on the scrim and the subtle lilac/black gradients on the drafting status bar and review footer.

---

## 8. Edge cases

### Empty plan after drafting

The agent finishes streaming but `planText` has fewer than ~20 non-whitespace chars, or `marked.lexer()` returns zero blocks.

- **Detection:** `segmentPlan(planText).length === 0` at the moment of `turn_end`.
- **UX:** stay in a `review`-flavored shell but render an empty state in place of the markdown:
  > `// the agent didn't produce a plan. retry, edit your intent, or submit feedback.`
  > buttons: **retry** (`bridge.followUp(intentFraming(lastIntent))`), **edit intent** (`→ intent` phase), **dismiss**.
- The submit/approve buttons are disabled in this state (nothing to act on).

### Abort during drafting

User clicks **abort** mid-stream.

- `bridge.abort()` cancels the agent turn.
- `planText` is **discarded** and the phase reverts to `intent` with the previous intent restored in the textarea.
- `lastDraft` is preserved in component state for one cycle so the user can `Cmd+Z` recall it (future enhancement; v1 just discards).
- If `planText` is non-empty when the user clicks **edit intent** instead of **abort**, we offer "discard draft & edit?" inline — no modal. (v1 may simply discard without prompting.)

### Approve with no comments

User reaches `review`, reads the plan, and immediately clicks **approve & execute**.

- This is the happy path — no warning, no friction.
- `bridge.followUp(APPROVAL_PROMPT)` fires; phase → `running`.

### Approve with unsaved comments / open comment form

User has a comment form open (with text in the textarea) but presses ⌘↵ at the panel level.

- ⌘↵ inside the open form **saves the comment**, not approves. Standard text-editor precedence.
- To approve, the user closes the form first (`Esc` or click cancel), then ⌘↵.

### Submit review with annotations but a still-streaming partial response

Cannot happen by construction: **submit review** is only visible in `phase === "review"`, and we only enter `review` after `turn_end`. If the user reopens the panel mid-turn, they land back in `drafting`.

### Loop limit (revision N+1)

There is no built-in cap. The `revision` counter is shown in the header (`v3 · 4 comments`) for the user's own awareness. If a turn fails (RPC error, timeout, model 429), the host displays the error in chat as usual; the panel stays in `drafting` and the **edit intent** affordance acts as the recovery path.

### Approval prompt collides with running tool

The approval prompt is sent via `bridge.followUp`, which the bridge serializes onto its `follow_up` queue. If the agent is somehow still processing (it shouldn't be — `review` requires `turn_end`), the bridge handles ordering. We do not pre-empt.

### Tab switch during plan mode

Switching tabs calls `bridge.activateSession(otherId)` which resets per-session state. The plan panel **closes** as part of that reset. Returning to the original tab restores `planText`, `annotations`, `intent` from the bridge's per-session snapshot.

> **Action item for the implementer:** confirm `bridge` snapshots include `planText`, `annotations`, `intent`, `phase` under the active session. If not, add them to the snap shape and the `onUpdate()` notify call in `live.js`.

### Markdown lexer crash

`window.marked` may be absent (CDN failure) or `marked.lexer` may throw on pathological input.

- `segmentPlan` falls back to a single block containing the raw text in a `<pre>`. Annotation works on the whole document as block 0.
- A console warning is emitted; the user sees a small chip in the header: `// segmentation unavailable — comments apply to the whole plan`.

### Plan exceeds reasonable size

For v1 we render all blocks. If the plan exceeds ~200 blocks or ~50 KB, we add a `.plan-block-overflow` warning chip after block 200 and stop rendering. This is a backstop, not a limit — well-formed plans should never approach this.

### Comment textarea overflow

`max-height: 240px` with `overflow-y: auto`. The form does not push the saved comment chip out of view because the chip is rendered _below_ the form's container.

---

## 9. Prompt framing — final strings

These live in `src/live.js` next to the bridge wrappers (or in a small `framing.js` if it grows).

```js
const intentFraming = (intent) => `\
Please draft a plan for the following task. Write it in Markdown with clear \
sections: overview, approach, key steps, and risks. Do not start implementing \
yet — draft only for my review.

---

${intent.trim()}`;

const reviewFraming = (planText, annotations, overall) => {
  const lineComments = Object.entries(annotations)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, { raw, comment }]) => {
      const quoted = raw.split("\n").map(l => `> ${l}`).join("\n");
      return `${quoted}\n→ ${comment.trim()}`;
    })
    .join("\n\n");

  const sections = [
    "Please revise the plan based on this feedback.",
    lineComments && "Line comments:\n" + lineComments,
    overall.trim() && "Overall: " + overall.trim(),
    "Provide the full revised plan in Markdown.",
  ].filter(Boolean);

  return sections.join("\n\n");
};

const APPROVAL_PROMPT =
  "Plan approved. Please proceed to execute it. " +
  "Use your todo_write tool to track tasks as you go.";
```

> The agent's own `todo_write` is what lights up the kanban. We do not parse plan markdown to extract tasks — that path was rejected up front.

---

## 10. Implementation order (suggested)

1. **PhasePill** extensions (`intent`, `drafting`) + rename `draft → review` label. *(layout-only, no behavior)*
2. **`IntentPhase`** component + state hooks in `PlanKanban`. Wire `onSubmitIntent` to a no-op stub. *(verify visually)*
3. **`DraftingPhase`** + `planText` lift to `<App>` and feed from `message_update`. Wire abort.
4. **Block segmentation** (`segmentPlan` util) + **`AnnotablePlan`** with hover `+` and inline form. *(no submit yet)*
5. **`ReviewFooter`** with overall textarea + submit/approve. Wire framing functions.
6. **Keyboard shortcuts** + ⌘↵ precedence inside comment forms.
7. **Edge-case handling**: empty plan, abort-discard, lexer fallback.
8. **Snapshot persistence** in `live.js` — confirm tab switch restores plan state.
9. Cleanup of the old `mode = "review"` default and the `kanban-foot` review variant which `ReviewFooter` now replaces.

Each step is independently shippable; only step 5 onwards touches the bridge.
