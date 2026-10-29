//! Latest omp extension UI state of one session: the status lines and text
//! widgets extensions publish with `ctx.ui.setStatus` / `ctx.ui.setWidget`
//! (#52, `docs/architecture/extension-widgets.md`).
//!
//! omp sends both as fire-and-forget `extension_ui_request` frames and keeps
//! no state of its own that could be queried later. The frontend applies the
//! frames of the tab it is showing; a background tab's frames wait in the
//! event journal, whose bounded ring (4096 lines / 8 MiB, `agent/mod.rs`) a long streamed turn overflows. The stdout
//! reader therefore applies every frame here as well, and a reactivated tab
//! whose replay came back `dropped` loads this state instead
//! (`extension_ui_state` command). `seq` names the last frame applied, so the
//! frontend skips replayed and buffered frames the state already holds and
//! applies only newer ones — on top of the same state, that gives the same
//! result as here. It lives on the session's map entry, so it ends with the
//! process: an exit, a `stop_session` or a respawn under the same id
//! (profile switch) all start from nothing.
//!
//! Only whole frames are seen here: a frame omp splits into protocol-v2
//! chunks (over 1 MiB, far beyond the bounds below) reaches the frontend
//! live but not this store.

use serde_json::Value;

/// Keys kept per kind (statuses, widgets). A frame for a further key is
/// ignored until a key is removed; the frontend applies the same bound.
pub const MAX_KEYS: usize = 32;
/// Lines kept per widget; the frontend shows as many.
pub const MAX_LINES: usize = 50;
/// Bytes kept per status text or widget line, cut on a char boundary: a
/// memory bound on raw text, escape sequences included (`theme.fg` colours
/// and OSC 8 link URLs can make up most of a line). The frontend strips
/// those first and then shows at most 500 characters, so any line it can
/// show in full fits.
pub const MAX_TEXT_BYTES: usize = 4096;
/// Longer keys are ignored: a key is a card title and a tweak key.
pub const MAX_KEY_BYTES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ExtStatus {
    pub key: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ExtWidget {
    pub key: String,
    /// The first [`MAX_LINES`] string lines.
    pub lines: Vec<String>,
    /// String lines past [`MAX_LINES`], counted so the card can say so.
    pub more: usize,
}

/// Statuses and widgets in the order their keys first appeared; replacing a
/// key keeps its place, so a card never jumps in the rail (omp's TUI instead
/// sorts statuses by key and moves a replaced widget to the end).
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ExtUiState {
    pub statuses: Vec<ExtStatus>,
    pub widgets: Vec<ExtWidget>,
    /// Journal `seq` of the last `extension_ui_request` frame recorded
    /// (applied or ignored), 0 for none.
    pub seq: u64,
}

impl ExtUiState {
    /// Apply one parsed stdout frame. Everything but a well-formed
    /// `setStatus` / `setWidget` request is ignored.
    pub fn apply(&mut self, frame: &Value) {
        if frame.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
            return;
        }
        match frame.get("method").and_then(Value::as_str) {
            Some("setStatus") => {
                let Some(key) = valid_key(frame.get("statusKey")) else {
                    return;
                };
                // An absent `statusText` (omp drops the `undefined` field)
                // removes the key; so does anything that is not a string.
                match frame.get("statusText").and_then(Value::as_str) {
                    Some(text) => upsert(
                        &mut self.statuses,
                        |s| s.key == key,
                        || ExtStatus {
                            key: key.to_owned(),
                            text: bounded(text),
                        },
                    ),
                    None => self.statuses.retain(|s| s.key != key),
                }
            }
            Some("setWidget") => {
                let Some(key) = valid_key(frame.get("widgetKey")) else {
                    return;
                };
                match frame.get("widgetLines").and_then(Value::as_array) {
                    Some(lines) => upsert(
                        &mut self.widgets,
                        |w| w.key == key,
                        || {
                            // omp sends strings only; anything else is skipped.
                            let mut strings = lines.iter().filter_map(Value::as_str);
                            let kept = strings.by_ref().take(MAX_LINES).map(bounded).collect();
                            ExtWidget {
                                key: key.to_owned(),
                                lines: kept,
                                more: strings.count(),
                            }
                        },
                    ),
                    None => self.widgets.retain(|w| w.key != key),
                }
            }
            _ => {}
        }
    }
}

fn valid_key(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty() && k.len() <= MAX_KEY_BYTES)
}

/// The stdout reader's per-line hook, after the line's journal push: apply
/// `frame` (journal `seq`) to `state` when it is an `extension_ui_request`
/// (`frame_type` is the type the reader already read). A poisoned lock
/// leaves the state as it is.
pub(super) fn record(
    state: &std::sync::Mutex<ExtUiState>,
    seq: u64,
    frame_type: Option<&str>,
    frame: Option<&Value>,
) {
    if frame_type != Some("extension_ui_request") {
        return;
    }
    if let (Some(frame), Ok(mut state)) = (frame, state.lock()) {
        state.apply(frame);
        state.seq = seq;
    }
}

/// Replace the entry `is_key` finds in place, or append a new one while
/// fewer than [`MAX_KEYS`] are kept. `make` runs only when the entry is kept.
fn upsert<T>(entries: &mut Vec<T>, is_key: impl Fn(&T) -> bool, make: impl FnOnce() -> T) {
    if let Some(slot) = entries.iter_mut().find(|e| is_key(e)) {
        *slot = make();
    } else if entries.len() < MAX_KEYS {
        entries.push(make());
    }
}

fn bounded(text: &str) -> String {
    crate::text::prefix_within(text, MAX_TEXT_BYTES).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(key: &str, text: Option<&str>) -> Value {
        let mut f = json!({ "type": "extension_ui_request", "id": "1", "method": "setStatus", "statusKey": key });
        if let Some(t) = text {
            f["statusText"] = json!(t);
        }
        f
    }

    fn widget(key: &str, lines: Option<Value>) -> Value {
        let mut f = json!({ "type": "extension_ui_request", "id": "2", "method": "setWidget", "widgetKey": key });
        if let Some(l) = lines {
            f["widgetLines"] = l;
        }
        f
    }

    fn keys(s: &ExtUiState) -> (Vec<&str>, Vec<&str>) {
        (
            s.statuses.iter().map(|x| x.key.as_str()).collect(),
            s.widgets.iter().map(|x| x.key.as_str()).collect(),
        )
    }

    #[test]
    fn set_replace_and_remove_keep_first_appearance_order() {
        let mut s = ExtUiState::default();
        s.apply(&status("plan-mode", Some("⏸ plan")));
        s.apply(&status("review", Some("Loading…")));
        s.apply(&status("plan-mode", Some("📋 1/3")));
        assert_eq!(
            s.statuses,
            vec![
                ExtStatus {
                    key: "plan-mode".into(),
                    text: "📋 1/3".into()
                },
                ExtStatus {
                    key: "review".into(),
                    text: "Loading…".into()
                },
            ],
            "a replaced key keeps its place"
        );
        s.apply(&status("plan-mode", None));
        assert_eq!(keys(&s).0, vec!["review"], "absent statusText removes");

        s.apply(&widget("todos", Some(json!(["☐ a", "☑ b"]))));
        assert_eq!(s.widgets[0].lines, vec!["☐ a", "☑ b"]);
        assert_eq!(s.widgets[0].more, 0);
        s.apply(&widget("todos", None));
        assert!(s.widgets.is_empty(), "absent widgetLines removes");
    }

    #[test]
    fn record_stamps_the_seq_of_every_extension_frame_and_ignores_others() {
        let state = std::sync::Mutex::new(ExtUiState::default());
        let f = status("s", Some("v"));
        record(&state, 7, Some("extension_ui_request"), Some(&f));
        let agent_end = json!({ "type": "agent_end" });
        record(&state, 8, Some("agent_end"), Some(&agent_end));
        assert_eq!(state.lock().unwrap().seq, 7, "other frames leave seq alone");
        // A frame that changes nothing still advances seq, so the frontend
        // never re-applies it on a state where it would change something.
        let notify = json!({ "type": "extension_ui_request", "method": "notify" });
        record(&state, 9, Some("extension_ui_request"), Some(&notify));
        let s = state.lock().unwrap();
        assert_eq!((s.seq, s.statuses.len()), (9, 1));
    }

    #[test]
    fn statuses_and_widgets_are_separate_namespaces() {
        let mut s = ExtUiState::default();
        s.apply(&status("x", Some("status")));
        s.apply(&widget("x", Some(json!(["widget"]))));
        s.apply(&status("x", None));
        assert_eq!(keys(&s), (vec![], vec!["x"]));
    }

    #[test]
    fn malformed_and_unrelated_frames_change_nothing() {
        let mut s = ExtUiState::default();
        s.apply(&status("keep", Some("v")));
        s.apply(&widget("w", Some(json!(["l"]))));
        let before = s.clone();
        for frame in [
            json!({ "type": "agent_end" }),
            json!({ "type": "extension_ui_request", "method": "notify", "message": "hi" }),
            json!({ "type": "extension_ui_request", "method": "select", "statusKey": "keep" }),
            status("", Some("empty key")),
            status(&"k".repeat(MAX_KEY_BYTES + 1), Some("long key")),
            json!({ "type": "extension_ui_request", "method": "setStatus", "statusKey": 5, "statusText": "x" }),
            json!({ "type": "response", "method": "setWidget", "widgetKey": "w" }),
        ] {
            s.apply(&frame);
        }
        assert_eq!(s, before);
        // A widget whose lines are not an array is a removal, as omp only
        // ever sends an array or nothing.
        s.apply(&widget("w", Some(json!("not an array"))));
        assert_eq!(s.widgets, Vec::new());
    }

    #[test]
    fn bounds_keys_lines_and_text() {
        let mut s = ExtUiState::default();
        for i in 0..MAX_KEYS + 5 {
            s.apply(&status(&format!("k{i}"), Some("v")));
        }
        assert_eq!(s.statuses.len(), MAX_KEYS, "keys past the cap are ignored");
        s.apply(&status("k0", None));
        s.apply(&status("late", Some("v")));
        assert_eq!(
            s.statuses.last().map(|x| x.key.as_str()),
            Some("late"),
            "room again after a removal"
        );

        // 3-byte chars: the cap falls inside one, so the cut backs off.
        s.apply(&status("late", Some(&"€".repeat(MAX_TEXT_BYTES))));
        let text = &s.statuses.last().expect("late is kept").text;
        assert!(text.len() <= MAX_TEXT_BYTES && text.chars().all(|c| c == '€'));

        let lines: Vec<String> = (0..MAX_LINES + 20).map(|i| format!("{i}")).collect();
        s.apply(&widget("w", Some(json!(lines))));
        assert_eq!(s.widgets[0].lines.len(), MAX_LINES);
        assert_eq!(s.widgets[0].more, 20, "lines past the cap are counted");

        s.apply(&widget("mixed", Some(json!(["a", 1, null, "b"]))));
        assert_eq!(
            s.widgets[1].lines,
            vec!["a", "b"],
            "non-string lines are skipped"
        );
    }
}
