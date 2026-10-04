/* ═════════════════════════════════════════════════════════════════════
   composer.jsx — input area + slash palette + ⌘K command bridge
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;
const { parseMentionQuery, applyMention } = window.OMP_MENTIONS;
const { prepareImage, imageFilesFromTransfer, imageFilesFromClipboardAsync, toDataUrl, MAX_ATTACHMENTS } = window.OMP_IMAGES;
const { isDesktop, slashMenu, midPromptSlashToken, skillMenu, matchesQuery, insertText: slashInsertText } = window.OMP_SLASH;
const {
  entryOf: draftEntryOf, updateEntry: updateDraftEntry, pruneEntries: pruneDrafts, DRAFT_IDLE, recallInDraft,
  normalizePaste, shouldCollapsePaste, collapsePaste, pastesIn, expandPastes, inlinePaste,
} = window.OMP_SESSION_UI;
const { restoredDraft: restoredQueueDraft } = window.OMP_QUEUE;

// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` (display
// logic lives there so chrome.jsx's ⌘K/history hints can reuse it too,
// instead of each file re-deriving chord display independently). The guard
// here is the one thing that can't move: "registry not loaded yet"
// (`window.OMP_KEYMAP` absent — first render before keymap.js runs, should
// never happen in normal script order but guarded anyway) keeps showing
// `fallback`, distinct from "loaded but unbound" (the user cleared the
// binding), which `OMP_KEYMAP.hintFor`/`hintKeyFor` already report as `""`.
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}
function hintKeyFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintKeyFor(actionId) : fallback;
}

// ── The composer (input + plan/steer modes + send) ────────────────────
function Composer({ sessionId, sessionIds, onSend, onPick, planMode, onTogglePlan, planBlocked = "", goalMode = false, goalTint = false, onToggleGoal, goalBlocked = "", goalStrip = null, onOpenCmd, onOpenModel, currentModel, thinking, onLoadThinkingLevels, onSetThinking, isStreaming, backgroundWork = false, onAbort, onApprove, annotationCount = 0, microcopy, onFollowUp, draftInsert, promptHistory = [], promptInsert, queue, queueSending, onRemoveQueued, onPromoteQueued }) {
  // Drafts are per tab (issue #28). The composer stays mounted across tab
  // switches and keeps one draft per session id (app/session-ui.js
  // DRAFT_IDLE): text, pending image attachments (sent alongside the next
  // message), collapsed pastes, the prompt-history recall position, and the
  // count of image preparations still in flight — sendWith blocks while
  // that is nonzero, so a fast Enter can't race ahead of a paste/pick and
  // ship the image on the *next* message.
  // Everything below reads and writes the active tab's entry, except an
  // image preparation landing after a switch: it goes back to the tab it
  // was started in.
  const [drafts, setDrafts] = React.useState({});
  const draft = draftEntryOf(drafts, sessionId, DRAFT_IDLE);
  const { text, attachments, pendingImages } = draft;
  // What the draft can send. A goal needs its objective as text; a steer
  // (mid-turn) can be images alone; a plain send can also be plan
  // annotations alone (app-live.jsx merges them into the message).
  const hasText = !!text.trim();
  const steerable = goalMode ? hasText : hasText || attachments.length > 0;
  const sendable = steerable || (!goalMode && planMode && annotationCount > 0);
  const updateDraft = (id, fn) => setDrafts(m => updateDraftEntry(m, id, DRAFT_IDLE, fn));
  // Any text edit ends a prompt-history recall; only the recall step itself
  // (onKey) writes `historyNav` alongside the text.
  const setText = (next) => updateDraft(sessionId, d => ({ ...d, text: next, historyNav: null }));
  // Open tab ids, also read when an image preparation lands: a tab closed
  // meanwhile must not get its entry back.
  const sessionIdsRef = React.useRef(sessionIds);
  sessionIdsRef.current = sessionIds;
  const updateOpenDraft = (id, fn) => setDrafts(m => (sessionIdsRef.current?.includes(id)
    ? updateDraftEntry(m, id, DRAFT_IDLE, fn)
    : m));
  const sessionIdRef = React.useRef(sessionId);
  sessionIdRef.current = sessionId;
  React.useEffect(() => { setDrafts(m => pruneDrafts(m, sessionIds)); }, [sessionIds]);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const taRef   = React.useRef(null);
  // Prompt-history recall (issue #16, Arrow Up/Down): the recall position
  // and the stashed unsent draft live in the tab's draft entry
  // (`historyNav`, null = idle), so a recall started in one tab can never
  // restore that stash into another. onKey steps it via recallInDraft.
  const listRef = React.useRef(null);
  const attachCounterRef = React.useRef(0);
  const fileInputRef     = React.useRef(null);

  const cmds = window.OMP_DATA?.commands || [];

  // ── @-mention file-path autocomplete ─────────────────────────────────
  // Caret tracked separately from `text`: the mention token depends on
  // *where* the cursor sits, not just the text content — arrow-key/mouse
  // moves into an existing @token must re-derive it without an edit.
  const [caret, setCaret]                       = React.useState(0);
  const [mentionItems, setMentionItems]         = React.useState([]);
  const [mentionActiveIdx, setMentionActiveIdx] = React.useState(0);
  const [mentionDismissedKey, setMentionDismissedKey] = React.useState(null);
  const [slashDismissedKey, setSlashDismissedKey]     = React.useState(null);
  const mentionListRef = React.useRef(null);
  const mentionReqRef  = React.useRef(0);

  const mentionRange = React.useMemo(() => parseMentionQuery(text, caret), [text, caret]);
  const mentionKey    = mentionRange ? `${mentionRange.start}:${mentionRange.query}` : null;
  const showMention   = mentionRange !== null && mentionItems.length > 0 && mentionDismissedKey !== mentionKey;

  // A tab switch swaps the draft under the textarea: the caret, the slash
  // selection and the mention list (fetched from the other tab's project)
  // all described the previous tab. A layout effect, so nothing flashes
  // against the new draft; setting the textarea's value has already put
  // the native caret at its end. The mention fetch below re-runs on the
  // switch for the same reason.
  React.useLayoutEffect(() => {
    setCaret(text.length);
    setActiveIdx(0);
    setMentionItems([]);
    setMentionDismissedKey(null);
    setSlashDismissedKey(null);
  }, [sessionId]);

  // Debounced fetch — keyed on the query text, not the caret, so moving
  // the caret within an unchanged token never re-fires it, and on the tab,
  // whose project the list comes from. A monotonic request id drops a
  // response that lands after a newer query fired.
  React.useEffect(() => {
    // No active token — also forget any Escape-dismissal recorded for a
    // token that no longer exists, and invalidate any request already in
    // flight for it, so neither can resurrect stale items for an unrelated
    // later "@src" at the same offset (e.g. next message, or after fully
    // clearing the draft). A dismissal survives a same-offset backspace-
    // then-retype of the identical query, by design — Escape means "not
    // this exact text", and re-arriving at exactly that text should still
    // honor it until the query actually differs.
    if (!mentionRange) {
      mentionReqRef.current++;
      setMentionItems([]);
      setMentionDismissedKey(null);
      return;
    }
    const myReq = ++mentionReqRef.current;
    const timer = setTimeout(async () => {
      const items = await window.OMP_BRIDGE.listFiles(mentionRange.query, 30);
      if (mentionReqRef.current === myReq) { setMentionItems(items); setMentionActiveIdx(0); }
    }, 60);
    return () => clearTimeout(timer);
  }, [mentionRange?.query, mentionRange !== null, sessionId]);

  // Derive slash state inline — no useEffect, no stale flicker. Suppressed
  // while the mention menu is showing: both can't render in the same
  // absolutely-positioned spot (e.g. "/plan add @src/foo.js"). Once
  // arguments are typed after a non-desktop (RPC) command, slashMenu
  // returns [] — that command runs inside omp, not here, so the popup
  // gets out of the way and Enter sends the literal text as a prompt.
  //
  // Mid-prompt (#30): a `/token` ending at the caret after other prompt
  // text lists matching skills, by omp's own editor rules (see
  // slash-commands.js). It wins over the leading-command popup, as in omp
  // ("/plan do /sk"); when no skill matches, the leading popup applies as
  // before. Escape dismisses only that token, like the @ list — never the
  // draft, which here is the user's prose.
  const slashRange = React.useMemo(() => midPromptSlashToken(text, caret), [text, caret]);
  const slashKey   = slashRange ? `${slashRange.start}:${slashRange.query}` : null;
  // A dismissal belongs to one token: once there is none (sent, deleted,
  // caret moved off it), forget it, or the same offset and query in a later
  // message would never open the list — same rule as the @ list.
  React.useEffect(() => { if (!slashRange) setSlashDismissedKey(null); }, [slashRange === null]);
  const skillHits  = slashRange && slashDismissedKey !== slashKey ? skillMenu(cmds, slashRange.query) : [];
  const midSlash   = skillHits.length > 0;
  const filtered   = midSlash ? skillHits : slashMenu(cmds, text);
  const showSlash  = filtered.length > 0 && !showMention;

  // Keep activeIdx in bounds; auto-select when single result
  const clampedIdx = showSlash ? Math.min(activeIdx, filtered.length - 1) : 0;

  // Scroll active item into view
  React.useEffect(() => {
    if (!showSlash || !listRef.current) return;
    const el = listRef.current.children[clampedIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx, showSlash]);

  // Scroll active mention row into view
  React.useEffect(() => {
    if (!showMention || !mentionListRef.current) return;
    const el = mentionListRef.current.children[mentionActiveIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [mentionActiveIdx, showMention]);

  // Grow with the text up to the CSS max-height, then scroll: hidden
  // overflow past it would leave the rest of a long draft unreachable.
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    // Read before the writes below, while style is still clean. Measure
    // without the last pass's scrollbar, whose width would change wrapping.
    const max = parseFloat(getComputedStyle(ta).maxHeight) || Infinity;
    ta.style.height = "auto";
    ta.style.overflowY = "hidden";
    const full = ta.scrollHeight;
    ta.style.height = `${Math.min(full, max)}px`;
    if (full > max) ta.style.overflowY = "auto";
  }, [text]);

  // Restore focus when the agent finishes streaming and the textarea
  // re-enables — unless the user is typing somewhere else by then (an
  // inline tab rename, #32, commits on blur; the ⌘K input): taking focus
  // from it would commit a half-typed name or drop the keystrokes.
  React.useEffect(() => {
    if (isStreaming) return;
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el && window.OMP_KEYMAP?.isTypingTarget(el)) return;
      taRef.current?.focus();
    });
  }, [isStreaming]);

  // Shared by the inline `/` popup's non-desktop pick and the ⌘K bridge's
  // draftInsert below — both replace the composer's text with a command
  // token and put the caret at its end, ready for arguments.
  const replaceDraft = (next) => {
    setText(next);
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = next.length;
    });
  };

  // CommandBridge (⌘K) hands a non-desktop pick here the same way — see
  // its `onInsertDraft` prop. Keyed on `nonce` (not `text`) so picking the
  // same command twice in a row still re-fires the effect. Unlike the
  // inline popup (only ever visible while `text` already starts with the
  // command being replaced), ⌘K has no textarea of its own — the composer
  // may be holding an unrelated typed draft when it's opened. A non-empty,
  // non-slash draft is kept as the inserted command's argument instead of
  // silently discarded; `text` is deliberately read directly (not depended
  // on) so this only fires on a new pick, using whatever draft is current
  // at that moment.
  React.useEffect(() => {
    if (!draftInsert) return;
    const trimmed = text.trim();
    const next = trimmed && !trimmed.startsWith("/") ? draftInsert.text + trimmed : draftInsert.text;
    replaceDraft(next);
  }, [draftInsert?.nonce]);

  // Prompt-history picker (Ctrl+Up modal) hands a pick here the same way
  // ⌘K's draftInsert does — keyed on `nonce` so picking the same prompt
  // twice in a row still re-fires. Unlike draftInsert, this always
  // *replaces* the draft (the modal's contract is "put this message
  // directly in the prompt box"), never appends an existing one. `images`
  // (a goal start omp refused) go back in as attachments. An insert from
  // before this composer mounted (it unmounts while no tab is open) is not
  // replayed into the next tab's draft.
  const seenInsertRef = React.useRef(promptInsert?.nonce);
  React.useEffect(() => {
    if (!promptInsert || promptInsert.nonce === seenInsertRef.current) return;
    seenInsertRef.current = promptInsert.nonce;
    replaceDraft(promptInsert.text);
    const images = promptInsert.images ?? [];
    if (images.length === 0) return;
    const back = images.map(image => ({ id: `att-${++attachCounterRef.current}`, name: "", image, src: toDataUrl(image) }));
    updateDraft(sessionId, d => ({ ...d, attachments: [...d.attachments, ...back].slice(0, MAX_ATTACHMENTS) }));
  }, [promptInsert?.nonce]);

  const execCmd = (cmd) => {
    // A mid-prompt skill pick replaces only its `/token` with
    // `/skill:name `; the prose around it stays, and omp passes it to the
    // skill as arguments on send.
    if (midSlash) {
      spliceDraft(slashRange, slashInsertText(cmd));
      setActiveIdx(0);
      return;
    }
    // A non-desktop (RPC) command has no handler in app-live.jsx's
    // handleCommand — it runs inside omp. Insert `/name ` and leave focus
    // in the composer instead of firing it immediately: the user adds
    // arguments (or none) and Enter sends it as a normal prompt, same as
    // typing the whole thing by hand. Guards against a one-click accident
    // on a destructive command like `/delete`.
    if (!isDesktop(cmd)) {
      replaceDraft(slashInsertText(cmd));
      return;
    }
    // Text typed after a desktop command goes to its handler: `/goal
    // <objective>` puts the objective back into the composer in goal mode.
    const args = expandPastes(/^\/\S*\s+([\s\S]*)$/.exec(text)?.[1]?.trim() ?? "", draft.pastes);
    updateDraft(sessionId, d => ({ ...d, text: "", pastes: DRAFT_IDLE.pastes, pasteCounter: 0 }));
    setActiveIdx(0);
    setMentionDismissedKey(null);
    onPick?.(cmd, args);
  };

  // Replace `range` (an @mention or mid-prompt `/token`) with `insert` and
  // put the caret right after it.
  const spliceDraft = (range, insert) => {
    const { text: nextText, caret: nextCaret } = applyMention(text, range, insert);
    setText(nextText);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = nextCaret;
      ta.focus();
    });
  };

  // The '@' itself is part of `insertText`, not just a display trigger:
  // the sent message keeps "@path/to/file" as a recognizable in-text file
  // reference (same convention as Claude Code's own @file mentions).
  // A directory pick's trailing '/' (no space) keeps the token "open" so
  // parseMentionQuery still matches it next render, re-querying one level
  // deeper — dropping the '@' here would silently break that, since the
  // token detector has nothing left to anchor on.
  //
  // A name containing whitespace or an embedded '@' can never stay
  // "open": parseMentionQuery stops its backward scan at the first space,
  // and separately rejects a query containing '@' (and an '@' preceded by
  // an ordinary character fails the token's own precursor check) — so
  // either character in the middle of the inserted path would make the
  // token permanently unrecoverable (drill-down silently dead for that
  // one directory, e.g. a Next.js parallel-route dir like `app/@modal`).
  // Closing normally instead still reaches nested entries — the backend
  // fuzzy-matches a full relative path in one query, so a fresh
  // "@dir with space/sub" from scratch works; drill-down is a
  // convenience, not a requirement.
  const pickMention = (item) => {
    if (!item || !mentionRange) return;
    const canStayOpen = item.isDir && !/[\s@]/.test(item.path);
    spliceDraft(mentionRange, canStayOpen ? `@${item.path}/` : `@${item.path} `);
  };

  // The long pastes still collapsed in the draft, for the chip strip.
  const collapsed = React.useMemo(() => pastesIn(text, draft.pastes), [text, draft.pastes]);

  // Applies a paste edit from session-ui.js and puts the caret where it
  // says, once the new text has rendered.
  const applyPasteEdit = (r) => {
    updateDraft(sessionId, d => ({ ...d, ...r.patch }));
    setCaret(r.caret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = r.caret;
    });
  };

  // A chip's "expand": the paste becomes editable text again.
  const expandPaste = (id) => {
    const r = inlinePaste(draft, id);
    if (r) applyPasteEdit(r);
  };

  // Route a completed draft through the full send pipeline. `dispatcher` is
  // either `onSend` (normal) or `onFollowUp` (follow-up); both get the same
  // paste-expansion, state-reset and focus-restore treatment. The slash-popup
  // shortcut only applies to a plain send — a follow-up must always send the
  // literal draft (plan §7: Ctrl+Q/Ctrl+Enter sends a follow-up even while a
  // '/' command is being typed), never silently reroute into executing the
  // highlighted palette command instead.
  const sendWith = (dispatcher, { followUp = false } = {}) => {
    if (showSlash && !followUp) { execCmd(filtered[clampedIdx]); return; }
    if (pendingImages > 0) return; // a paste/pick is still preparing — its image would ship on the *next* message instead
    // A follow-up (`onFollowUp` dispatcher) requires non-empty text.
    if (!(followUp ? hasText : sendable)) return;
    const images = attachments.map(a => a.image);
    dispatcher(expandPastes(text.trim(), draft.pastes), images);
    // Back to an empty draft: text, attachments and collapsed pastes all
    // went out with this message, and the reset ends any prompt-history
    // recall. The in-flight image count is kept: an async-clipboard paste
    // can have queued its increment after the render this send read, and
    // its decrement still lands later.
    updateDraft(sessionId, d => (d.pendingImages ? { ...DRAFT_IDLE, pendingImages: d.pendingImages } : DRAFT_IDLE));
    setMentionDismissedKey(null);
    setSlashDismissedKey(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // ✎ on a queued message (QueueStrip): omp removes it first, and only a
  // confirmed removal puts its text back — into the tab it was queued
  // from, ahead of anything typed there since. omp's queue does not hand
  // back attached images.
  const editQueued = async (row) => {
    const target = sessionId;
    const removed = await onRemoveQueued(row.text, row.kind);
    if (removed) {
      updateOpenDraft(target, d => ({ ...d, text: restoredQueueDraft(row.text, d.text), historyNav: null }));
      if (sessionIdRef.current === target) requestAnimationFrame(() => taRef.current?.focus());
    }
    return removed;
  };
  const send = () => sendWith(onSend);

  // Pick, downscale/re-encode and queue image files as pending attachments.
  // Silently drops files that fail to decode, and drops any that would push
  // the batch over MAX_ATTACHMENTS or MAX_TOTAL_ATTACH_BYTES, rather than
  // blocking the rest — same policy either way: keep what fits, drop the
  // rest of this paste/pick silently (the user can always attach the
  // dropped ones separately).
  const addFiles = async (fileList) => {
    // The tab this paste/pick belongs to: preparation is async, and the
    // result must not land in whichever tab is active by then.
    const target = sessionId;
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
    const room  = MAX_ATTACHMENTS - attachments.length;
    if (files.length === 0 || room <= 0) return;
    const slice = files.slice(0, room);
    // Counted only while the tab is open: a paste resolved through the
    // async clipboard path may land after its tab closed.
    updateOpenDraft(target, d => ({ ...d, pendingImages: d.pendingImages + slice.length }));
    let ok = [];
    try {
      const prepared = await Promise.all(slice.map(async (file) => {
        try {
          const image = await prepareImage(file);
          return { id: `att-${++attachCounterRef.current}`, name: file.name, image, src: toDataUrl(image) };
        } catch {
          return null; // undecodable file — drop, don't block the rest of the batch
        }
      }));
      ok = prepared.filter(Boolean);
    } finally {
      // Cap against the latest entry, not the `attachments` this call closed
      // over — a concurrent addFiles (fast double-paste) may have already
      // appended by the time this resolves. A tab closed meanwhile is left
      // without an entry rather than given one back.
      updateOpenDraft(target, d => ({
        ...d,
        attachments: ok.length > 0 ? [...d.attachments, ...ok].slice(0, MAX_ATTACHMENTS) : d.attachments,
        pendingImages: d.pendingImages - slice.length,
      }));
    }
  };
  const removeAttachment = (attId) =>
    updateDraft(sessionId, d => ({ ...d, attachments: d.attachments.filter(a => a.id !== attId) }));

  // Collapse long pastes (session-ui.js shouldCollapsePaste) into a token
  // so the textarea stays navigable; the chip strip above shows and
  // expands them. An image on the clipboard is attached in every case; it
  // only short-circuits the text handling below when there's no
  // accompanying text to preserve.
  const onPaste = (e) => {
    const imageFiles = imageFilesFromTransfer(e.clipboardData);
    const raw = normalizePaste(e.clipboardData?.getData("text/plain") ?? "");
    if (imageFiles.length > 0) {
      addFiles(imageFiles);
      // Some sources (spreadsheet cells, rich-text apps) put a rendered
      // bitmap on the clipboard *alongside* real text — attach the image
      // but keep going into the text handling below instead of discarding
      // it. Only an image with no accompanying text short-circuits here.
      if (!raw) { e.preventDefault(); return; }
    } else {
      // WebKitGTK never puts image/* into the synchronous paste event's
      // DataTransfer (only text/*), so the extraction above always comes
      // back empty there for an image paste — fall back to the async
      // Clipboard API, which does see it. Fire-and-forget: there is no
      // synchronous default action to block when the sync DataTransfer
      // carried no image, and on engines where the sync path already
      // works this resolves to zero files and is a no-op.
      imageFilesFromClipboardAsync().then((files) => { if (files.length > 0) addFiles(files); });
    }
    if (!shouldCollapsePaste(raw)) return; // short — let browser handle normally
    e.preventDefault();
    const ta    = taRef.current;
    const start = ta ? ta.selectionStart : text.length;
    const end   = ta ? ta.selectionEnd   : text.length;
    applyPasteEdit(collapsePaste(draft, raw, start, end));
  };

  const onKey = (e) => {
    if (showMention) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionActiveIdx(i => (i + 1) % mentionItems.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMentionActiveIdx(i => (i - 1 + mentionItems.length) % mentionItems.length); return; }
      if (e.key === "Escape")    { e.preventDefault(); setMentionDismissedKey(mentionKey); return; }
      if (e.key === "Tab" || (isSubmitEnter(e) && !e.shiftKey)) { e.preventDefault(); pickMention(mentionItems[mentionActiveIdx]); return; }
    }
    if (showSlash) {
      if (e.key === "ArrowDown")  { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Escape")     { e.preventDefault(); if (midSlash) setSlashDismissedKey(slashKey); else setText(""); return; }
      if (e.key === "Tab")        { e.preventDefault(); setActiveIdx(i => (i + 1) % filtered.length); return; }
    }
    // Prompt-history recall (issue #16) — only when neither popup owns the
    // arrows, no modifier is held (a modified arrow is a different chord,
    // e.g. the Ctrl+Up picker handled globally by use-keymap.jsx, and
    // Shift+Up/Down is the native select-to-start/end gesture), and the
    // caret sits on the first/last line respectively — mirrors a shell's
    // "only recall when there's nothing to navigate past" behavior so a
    // multi-line draft's internal Up/Down still moves the caret normally.
    if (!showMention && !showSlash && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const ta = taRef.current;
      const start = ta ? ta.selectionStart : text.length;
      const end   = ta ? ta.selectionEnd   : text.length;
      const H = window.OMP_PROMPT_HISTORY;
      const eligible = dir < 0 ? H.caretOnFirstLine(text, start, end) : H.caretOnLastLine(text, start, end);
      // recallInDraft (app/session-ui.js) also drops a recall position the
      // text has drifted from — a lowered tweaks-panel limit, a paste-token
      // collapse — instead of trusting a stale index.
      const next = eligible ? recallInDraft(draft, promptHistory, dir, H.step) : null;
      if (next) {
        e.preventDefault();
        updateDraft(sessionId, d => ({ ...d, text: next.text, historyNav: next.historyNav }));
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (!el) return;
          el.selectionStart = el.selectionEnd = next.text.length;
        });
        return;
      }
    }
    // followUp must be checked before the plain-Enter branch: `ctrl+enter` is
    // a default followUp chord and `isSubmitEnter` would match it first.
    if (window.OMP_KEYMAP?.matches(e.nativeEvent ?? e, "app.message.followUp")) {
      e.preventDefault();
      if (onFollowUp) sendWith(onFollowUp, { followUp: true });
      return;
    }
    // isSubmitEnter (app/constants.js) owns the IME-composition guard.
    if (isSubmitEnter(e) && !e.shiftKey) { e.preventDefault(); send(); return; }
  };

  // Live keymap hints — computed once per render, reused across the
  // placeholder, title, kbd chips and footer so they can never disagree.
  const bridgeHint    = hintFor("desktop.commands.open", "⌘K");
  const bridgeKeyHint = hintKeyFor("desktop.commands.open", "K");
  const abortHint = hintFor("app.interrupt", "⎋");
  const cycleThinkingHint = hintFor("app.thinking.cycle", "⇧Tab");

  return (
    <div className={`composer${planMode ? " plan-on" : ""}${goalTint ? " goal-on" : ""}${goalMode ? " goal-draft" : ""}`}>
      {planMode && (
        <div className="plan-strip">
          <Icon name="plan" size={12} color="var(--amber)" />
          <span style={{ color: "var(--amber)" }}>plan mode</span>
          <span style={{ color: "var(--fg-3)" }}>· I'll draft before I write</span>
          <button className="btn ghost" onClick={onTogglePlan} style={{ marginLeft: "auto", height: 22 }}>exit</button>
        </div>
      )}
      {/* Goal mode (goal-strip.jsx): built by app-live.jsx, keyed by tab. */}
      {goalStrip}

      {showSlash && (
        <div className="slash-pop" ref={listRef}>
          {filtered.map((c, i) => (
            <button key={c.name}
              className={`slash-row${i === clampedIdx ? " active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); execCmd(c); }}>
              <span className="slash-glyph">{c.icon}</span>
              <span className="slash-name mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
              <span className="slash-hint" style={{ color: "var(--fg-3)" }} title={c.hint}>{c.hint}</span>
              <span className="chip muted" style={{ marginLeft: "auto", flex: "none" }}>{c.group}</span>
            </button>
          ))}
        </div>
      )}

      {showMention && (
        <MentionMenu
          items={mentionItems}
          activeIndex={mentionActiveIdx}
          onPick={pickMention}
          onHover={setMentionActiveIdx}
          listRef={mentionListRef}
        />
      )}

      {/* Keyed by tab, like the paste strip: a pending action or notice
          belongs to the tab it was taken in. */}
      <QueueStrip key={`queue-${sessionId}`} queue={queue} sending={queueSending}
        onRemove={row => onRemoveQueued(row.text, row.kind)}
        onPromote={row => onPromoteQueued(row.text)}
        onEdit={editQueued} />

      {attachments.length > 0 && (
        <div className="attach-strip">
          {attachments.map(a => (
            <div className="attach-chip" key={a.id}>
              <img className="attach-thumb" src={a.src} alt={a.name || "attached image"} />
              <button className="attach-remove" title="remove" onClick={() => removeAttachment(a.id)}>
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Keyed by tab: an open preview is that tab's, not the next one's. */}
      <PasteStrip key={sessionId} pastes={collapsed} onExpand={expandPaste} />

      <div className="composer-row">
        <button className="btn icon ghost" title="attach image" onClick={() => fileInputRef.current?.click()}>
          <Icon name="image" size={13} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
        <button className="btn icon ghost" title="dictate">
          <Icon name="voice" size={13} />
        </button>
        <div className="composer-input">
          <textarea
            ref={taRef}
            rows="1"
            placeholder={
              goalMode && !isStreaming
                ? "describe the goal — the agent works toward it until it calls it done…"
                : planMode && !isStreaming
                ? (microcopy?.planTip ?? "describe what to build, or give feedback on the plan…")
                : isStreaming
                  ? microcopy?.streamingTip
                  : (microcopy?.paletteTip ?? `what should we ship?  ·  / for commands${bridgeHint ? `  ·  ${bridgeHint} for the bridge` : ""}`)
            }
            value={text}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            onKeyDown={onKey}
            onPaste={onPaste}
            className="selectable"
            role={showMention ? "combobox" : undefined}
            aria-expanded={showMention ? true : undefined}
            aria-controls={showMention ? "mention-menu" : undefined}
            aria-activedescendant={showMention ? `mention-row-${mentionActiveIdx}` : undefined}
          />
        </div>
        <button className="btn outlined" title={bridgeHint ? `open command bridge (${bridgeHint})` : "open command bridge"} onClick={onOpenCmd}>
          <Icon name="command" size={11} />
          {bridgeKeyHint && <span className="kbd" style={{ marginLeft: 2 }}>{bridgeKeyHint}</span>}
        </button>
        {isStreaming ? (
          <>
            {steerable && (
              <button className={`btn outlined${goalMode ? " goal-resume" : ""}`} onClick={send} disabled={pendingImages > 0}
                style={goalMode ? undefined : { color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 40%, var(--line))" }}>
                <Icon name={goalMode ? "goal" : "arrow"} size={10} color={goalMode ? "var(--lilac)" : "var(--amber)"} /> {goalMode ? "start goal" : "steer"}
              </button>
            )}
            <button className="btn danger" onClick={onAbort}>
              <Icon name="stop" size={10} /> abort {abortHint && <span className="kbd">{abortHint}</span>}
            </button>
          </>
        ) : (
          <>
            {planMode && (
              <button className="btn outlined" onClick={onApprove}
                style={{ color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 40%, var(--line))" }}>
                <Icon name="play" size={10} color="var(--amber)" /> approve
              </button>
            )}
            <button className={`btn primary${goalMode ? " goal-start" : ""}`} onClick={send}
              disabled={!sendable || pendingImages > 0}>
              {goalMode
                ? "start goal"
                : planMode
                ? `send feedback${annotationCount > 0 ? ` · ${annotationCount} comment${annotationCount !== 1 ? "s" : ""}` : ""}`
                : "send"}
              {" "}<Icon name="arrow" size={11} />
            </button>
          </>
        )}
      </div>

      <div className="composer-foot">
        <button className="composer-pill" onClick={onOpenModel}>
          <span className="dot live" />
          <span style={{ color: "var(--fg-2)" }}>{currentModel?.name}</span>
          <Icon name="chev" size={10} color="var(--fg-4)" />
        </button>
        <ThinkingMenu key={sessionId} model={currentModel} level={thinking}
          cycleHint={cycleThinkingHint} onLoad={onLoadThinkingLevels} onSet={onSetThinking} />
        <button className={`composer-pill ${planMode ? "on" : ""}`} onClick={onTogglePlan}
          disabled={!!planBlocked && !planMode} title={planBlocked && !planMode ? planBlocked : undefined}>
          <Icon name="plan" size={11} color={planMode ? "var(--amber)" : "var(--fg-3)"} />
          <span style={{ color: planMode ? "var(--amber)" : "var(--fg-2)" }}>plan mode</span>
        </button>
        <button className={`composer-pill goal-pill${goalMode ? " on" : ""}`} onClick={onToggleGoal}
          disabled={!!goalBlocked && !goalMode}
          title={goalBlocked && !goalMode ? goalBlocked : "goal mode: your next message becomes a goal the agent works toward"}>
          <Icon name="goal" size={11} color={goalMode ? "var(--lilac)" : "var(--fg-3)"} />
          <span style={{ color: goalMode ? "var(--lilac)" : "var(--fg-2)" }}>goal</span>
        </button>
        <div style={{ flex: 1 }} />
        {backgroundWork && (
          <span className="composer-bg-note" title="omp reports background work (an async bash, task or eval job) whose result will wake the agent">
            <TabRunDot state="background" />
            background job running · the agent resumes when it finishes
          </span>
        )}
        <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
          {[
            ...(isStreaming && steerable
              ? [goalMode ? "↵ start goal" : "↵ steer"]
              : [goalMode ? "↵ start goal" : "↵ send", "⇧↵ newline"]),
            // Dropped entirely when unbound rather than showing a keyless
            // "abort" segment that advertises a shortcut that isn't there.
            ...(abortHint ? [`${abortHint} abort`] : []),
          ].join(" · ")}
        </span>
      </div>
    </div>
  );
}

// ── ⌘K Command bridge — two views: commands → model picker ────────────
//
//  commands view  — lists all slash-commands; /model drills into picker
//  models view    — filterable model list, the profile's most recently used
//                   models (omp's own MRU, #11) first; Esc returns to commands
//

// Recently used models pinned above the full list (#11).
const RECENT_MODEL_LIMIT = 5;

function CommandBridge({ open, onClose, onPick, onPickModel, currentModelId, profileId, onPickLogin, onInsertDraft, loginProviders, initialView = "commands" }) {
  const [q, setQ]       = React.useState("");
  const [view, setView] = React.useState("commands");
  const inputRef = React.useRef(null);
  // omp's MRU is per profile (each has its own agent.db), so the list is
  // fetched *for* `profileId` and tagged with it, and only shown while that
  // is still the active tab's profile — a tab switch or a profile respawn
  // never shows another profile's order, not even until the refetch lands.
  // Refetched on every entry into the models view and on a profile change
  // while open: omp records a switch the moment it happens (here, in
  // another tab, or in its terminal UI). A response for a profile left
  // meanwhile is dropped (`live`).
  const [recent, setRecent] = React.useState({ profileId: null, keys: [] });
  const recentKeys = recent.profileId === profileId ? recent.keys : [];

  React.useEffect(() => {
    if (open) {
      setQ("");
      setView(initialView);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open || view !== "models") return undefined;
    let live = true;
    window.OMP_BRIDGE?.recentModels?.(profileId).then((keys) => {
      if (live && Array.isArray(keys)) setRecent({ profileId, keys });
    });
    return () => { live = false; };
  }, [open, view, profileId]);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || !open) return;
      if (view === "models") { if (initialView === "models") onClose(); else { setView("commands"); setQ(""); } }
      else if (view === "login") { if (initialView === "login") onClose(); else { setView("commands"); setQ(""); } }
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, view]);

  if (!open) return null;

  const fil    = (s) => s.toLowerCase().includes(q.toLowerCase());
  const models = window.OMP_DATA.models;

  // ── Model picker view ──────────────────────────────────────────────
  if (view === "models") {
    const modelHits = models.filter((m) => !q || fil(m.name) || fil(m.id));
    const recentHits = window.pickRecentModels(modelHits, recentKeys, RECENT_MODEL_LIMIT);
    const modelRow = (m, group) => (
      <button key={`${group}:${window.modelKey(m)}`}
        className={`bridge-row ${m.id === currentModelId ? "active" : ""}`}
        onClick={() => { onPickModel(m); onClose(); }}>
        <span className="bridge-glyph">
          {m.id === currentModelId
            ? <Icon name="check" size={10} color="var(--accent)" />
            : <Icon name="bolt"  size={10} color="var(--cyan)" />}
        </span>
        <span style={{ color: m.id === currentModelId ? "var(--accent)" : "var(--fg)" }}>{m.name}</span>
        <span className="mono" style={{ color: "var(--fg-4)" }}>{m.id}</span>
        <span style={{ color: "var(--fg-3)" }}>· {m.note}</span>
        <span className="chip muted" style={{ marginLeft: "auto" }}>{m.latency}ms</span>
      </button>
    );
    return (
      <div className="bridge-scrim" onClick={onClose}>
        <div className="bridge slide-in" onClick={(e) => e.stopPropagation()}>
          <div className="bridge-input-row">
            <button className="btn icon ghost" title="back"
              onClick={() => { setView("commands"); setQ(""); }}
              style={{ marginRight: 4 }}>
              <Icon name="chevR" size={12} color="var(--fg-3)"
                style={{ transform: "rotate(180deg)", display: "block" }} />
            </button>
            <input ref={inputRef} className="bridge-input mono"
              placeholder="filter models…" value={q}
              onChange={(e) => setQ(e.target.value)} />
            <span className="kbd">esc</span>
          </div>
          <div className="bridge-body">
            {recentHits.length > 0 && (
              <div className="bridge-group">
                <div className="bridge-group-head mono">recently used</div>
                {recentHits.map((m) => modelRow(m, "recent"))}
              </div>
            )}
            <div className="bridge-group">
              <div className="bridge-group-head mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                all models
                <span style={{ color: "var(--fg-4)" }}>
                  tauri:{window.__TAURI__ ? "✓" : "✗"}
                  · connected:{window.OMP_BRIDGE?.isConnected ? "✓" : "✗"}
                  · models:{window.OMP_DATA.models.length}
                </span>
                <button className="btn ghost" style={{ marginLeft: "auto", height: 18, fontSize: "var(--d-text-xs)", padding: "0 6px" }}
                  onClick={() => window.OMP_BRIDGE?.refreshModels()}>
                  refresh
                </button>
              </div>
              {modelHits.map((m) => modelRow(m, "all"))}
              {modelHits.length === 0 && <div className="bridge-empty">no models found</div>}
            </div>
          </div>
          <div className="bridge-foot mono">
            <span className="kbd">↑↓</span> navigate
            <span className="kbd">↵</span> switch
            <span className="kbd">esc</span> back
          </div>
        </div>
      </div>
    );
  }

  // ── Login view ───────────────────────────────────────────────────────────
  if (view === "login") {
    return (
      <div className="bridge-scrim" onClick={onClose}>
        <div className="bridge slide-in" onClick={(e) => e.stopPropagation()}>
          <div className="bridge-input-row">
            <button className="btn icon ghost" title="back"
              onClick={() => { setView("commands"); setQ(""); }}
              style={{ marginRight: 4 }}>
              <Icon name="chevR" size={12} color="var(--fg-3)"
                style={{ transform: "rotate(180deg)", display: "block" }} />
            </button>
            <span className="bridge-input mono" style={{ cursor: "default", lineHeight: "normal" }}>
              login
            </span>
            <span className="kbd">esc</span>
          </div>
          <div className="bridge-body">
            <div className="bridge-group">
              <div className="bridge-group-head mono">select provider</div>
              {loginProviders === null && (
                <div className="bridge-empty" style={{ padding: "16px 32px" }}>loading providers…</div>
              )}
              {loginProviders !== null && loginProviders.length === 0 && (
                <div className="bridge-empty">no providers available</div>
              )}
              {loginProviders !== null && loginProviders.map((p) => (
                <button key={p.id}
                  className={`bridge-row ${p.authenticated ? "active" : ""}`}
                  onClick={() => { if (p.available) { onPickLogin(p); onClose(); } }}>
                  <span className="bridge-glyph">
                    {p.authenticated
                      ? <Icon name="check" size={10} color="var(--accent)" />
                      : <Icon name="bolt"  size={10} color={p.available ? "var(--cyan)" : "var(--fg-5)"} />}
                  </span>
                  <span style={{ color: p.authenticated ? "var(--accent)" : p.available ? "var(--fg)" : "var(--fg-4)" }}>
                    {p.name}
                  </span>
                  <span className="mono" style={{ color: "var(--fg-4)" }}>{p.id}</span>
                  <span className="chip muted" style={{ marginLeft: "auto" }}>
                    {p.authenticated ? "logged in" : p.available ? "available" : "unavailable"}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="bridge-foot mono">
            <span className="kbd">↵</span> authenticate
            <span className="kbd">esc</span> back
          </div>
        </div>
      </div>
    );
  }

  // ── Commands view ──────────────────────────────────────────────────
  const cmds    = window.OMP_DATA.commands;
  const cmdHits = cmds.filter((c) => matchesQuery(c, q));
  const groups  = {};
  cmdHits.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
  const activeModelName = models.find((m) => m.id === currentModelId)?.name ?? "–";

  return (
    <div className="bridge-scrim" onClick={onClose}>
      <div className="bridge slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="bridge-input-row">
          <Icon name="command" size={14} color="var(--accent)" />
          <input ref={inputRef} className="bridge-input mono"
            placeholder="cross the bridge — type to filter…" value={q}
            onChange={(e) => setQ(e.target.value)} />
          <span className="kbd">esc</span>
        </div>
        <div className="bridge-body">
          {Object.entries(groups).map(([g, list]) => (
            <div key={g} className="bridge-group">
              <div className="bridge-group-head mono">{g.toLowerCase()}</div>
              {list.map((c) => {
                const isModel = c.name === "model";
                const isLogin = c.name === "login";
                const drillsIn = isModel || isLogin;
                return (
                  <button key={c.name} className="bridge-row"
                    onClick={() => {
                      if (isModel) { setQ(""); setView("models"); }
                      else if (isLogin) { setQ(""); setView("login"); }
                      else if (isDesktop(c)) { onPick(c); onClose(); }
                      else { onInsertDraft(slashInsertText(c)); onClose(); }
                    }}>
                    <span className="bridge-glyph">{c.icon}</span>
                    <span className="bridge-cmd-name mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
                    <span className="bridge-cmd-hint" style={{ color: "var(--fg-3)" }} title={c.hint}>{c.hint}</span>
                    {isModel && (
                      <span className="mono" style={{ color: "var(--fg-4)", marginLeft: "auto" }}>
                        {activeModelName}
                      </span>
                    )}
                    <Icon name={drillsIn ? "chevR" : "arrow"} size={11} color="var(--fg-4)"
                      style={{ marginLeft: drillsIn ? 8 : "auto" }} />
                  </button>
                );
              })}
            </div>
          ))}
          {cmdHits.length === 0 && (
            <div className="bridge-empty">no luck — try `plan`, `branch`, `model`…</div>
          )}
        </div>
        <div className="bridge-foot mono">
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> run
          <span className="kbd">esc</span> close
          <span style={{ marginLeft: "auto", color: "var(--fg-4)" }}>{window.OMP_DATA.microcopy.paletteTip}</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Composer, CommandBridge });
