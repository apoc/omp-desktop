//! What a view knows about its Chromium: the panel size, the page targets
//! and which one is shown.

use std::time::{Duration, Instant};

use serde_json::Value;

use super::emit::{Status, TabInfo, ViewState};

/// After a tab picked by the user, the view does not follow the agent for
/// this long.
const FOLLOW_HOLD: Duration = Duration::from_secs(5);
const MAX_EDGE: u32 = 8192;
/// Screencast restarts for a frame of the wrong size, see
/// [`Inner::frame_needs_restart`].
const MAX_HEALS: u8 = 5;
const HEAL_GAP: Duration = Duration::from_millis(300);
const HEAL_REFILL: Duration = Duration::from_secs(5);

/// The panel's CSS size and device pixel ratio.
#[derive(Clone, Copy, Debug)]
pub(super) struct Size {
    pub w: u32,
    pub h: u32,
    pub dpr: f64,
}

impl Size {
    pub fn new(w: u32, h: u32, dpr: f64) -> Result<Self, String> {
        if (1..=MAX_EDGE).contains(&w) && (1..=MAX_EDGE).contains(&h) && (0.25..=8.0).contains(&dpr)
        {
            Ok(Self { w, h, dpr })
        } else {
            Err(format!("invalid panel size {w}x{h} at {dpr}x"))
        }
    }

    /// Image pixels of `css` CSS pixels.
    pub fn px(self, css: u32) -> u32 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let px = (f64::from(css) * self.dpr).round() as u32; // w, h and dpr are range-checked
        px
    }
}

pub(super) struct Page {
    pub target_id: String,
    pub title: String,
    pub url: String,
}

pub(super) struct Active {
    pub target_id: String,
    pub session: String,
    /// Which activation this is; a new page session or a switch makes a
    /// new one.
    pub generation: u64,
}

pub(super) struct Inner {
    pub pages: Vec<Page>,
    pub active: Option<Active>,
    pub size: Size,
    /// Off until `open` has taken the targets that existed already.
    pub following: bool,
    /// The page the agent worked in that the view does not list yet.
    pending_follow: Option<String>,
    pub user_activated: Option<Instant>,
    /// How long `user_activated` keeps the view from following the agent.
    pub follow_hold: Duration,
    /// Activations so far, see [`set_active`](Self::set_active).
    activations: u64,
    /// What the last `tabs` event said.
    published_tabs: Vec<TabInfo>,
    pub state: ViewState,
    /// Screencast restarts asked for since the last frame of the panel's
    /// size.
    heals: u8,
    restart_pending: bool,
    last_restart: Option<Instant>,
}

impl Inner {
    pub const fn new() -> Self {
        Self {
            pages: Vec::new(),
            active: None,
            size: Size {
                w: 1,
                h: 1,
                dpr: 1.0,
            },
            following: false,
            pending_follow: None,
            follow_hold: FOLLOW_HOLD,
            activations: 0,
            user_activated: None,
            published_tabs: Vec::new(),
            state: ViewState::new(Status::Starting),
            heals: 0,
            restart_pending: false,
            last_restart: None,
        }
    }

    /// Whether a frame calls for a screencast restart. `css_w` x `css_h` is
    /// the CSS size its metadata claims and `proportioned` that its image
    /// has those proportions. Right after some navigations Chromium captures
    /// its whole window surface instead of the emulated viewport, with
    /// metadata that says either so or (on the first frame of a screencast)
    /// the viewport's size; a restart shows the viewport again. One restart
    /// is asked for at a time, at most `MAX_HEALS` in a row; the budget
    /// refills after `HEAL_REFILL`, so a surface that cannot match neither
    /// loops nor stays wrong for good.
    pub fn frame_needs_restart(&mut self, css_w: u32, css_h: u32, proportioned: bool) -> bool {
        if proportioned && (css_w, css_h) == (self.size.w, self.size.h) {
            self.heals = 0;
            return false;
        }
        if self
            .last_restart
            .is_some_and(|at| at.elapsed() >= HEAL_REFILL)
        {
            self.heals = 0;
        }
        if self.restart_pending || self.heals >= MAX_HEALS {
            return false;
        }
        self.heals += 1;
        self.restart_pending = true;
        true
    }

    /// How long the restart asked for must still wait to be `HEAL_GAP`
    /// after the previous one.
    pub fn restart_wait(&self) -> Duration {
        self.last_restart
            .map_or(Duration::ZERO, |at| HEAL_GAP.saturating_sub(at.elapsed()))
    }

    /// The restart is under way: the next wrong frame may ask again.
    pub fn restart_started(&mut self) {
        self.restart_pending = false;
        self.last_restart = Some(Instant::now());
    }

    /// Insert or update the page from a `targetInfo`; `true` when it is new.
    pub fn upsert_page(&mut self, info: &Value) -> bool {
        let text = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or_default();
        let Some(target_id) = info.get("targetId").and_then(Value::as_str) else {
            return false;
        };
        if let Some(page) = self.pages.iter_mut().find(|p| p.target_id == target_id) {
            text("title").clone_into(&mut page.title);
            text("url").clone_into(&mut page.url);
            return false;
        }
        self.pages.push(Page {
            target_id: target_id.to_owned(),
            title: text("title").to_owned(),
            url: text("url").to_owned(),
        });
        true
    }

    pub fn may_follow(&self) -> bool {
        self.following
            && self
                .user_activated
                .is_none_or(|at| at.elapsed() >= self.follow_hold)
    }

    /// Show `target_id` through `session`; the returned generation tells
    /// frames and input queued for this activation from later ones.
    pub fn set_active(&mut self, target_id: &str, session: &str) -> u64 {
        self.activations += 1;
        self.active = Some(Active {
            target_id: target_id.to_owned(),
            session: session.to_owned(),
            generation: self.activations,
        });
        self.activations
    }

    /// How many pages were shown so far.
    #[cfg(test)]
    pub const fn activations(&self) -> u64 {
        self.activations
    }

    /// The agent worked in `target_id`: `true` when the view shows it now,
    /// `false` when the user's recent choice holds the view back (the request
    /// is dropped) or the page is not listed yet. In that case one request
    /// is kept, and [`apply_target_event`](Self::apply_target_event) hands
    /// the page out when it appears.
    pub fn request_follow(&mut self, target_id: &str) -> bool {
        if !self.may_follow() {
            return false;
        }
        if self.pages.iter().any(|p| p.target_id == target_id) {
            self.pending_follow = None;
            return true;
        }
        self.pending_follow = Some(target_id.to_owned());
        false
    }

    /// Handle a target event: keep the pages current and give back the page
    /// to show, if it is the one [`request_follow`](Self::request_follow)
    /// was waiting for and the user's recent choice does not hold the view
    /// back.
    pub fn apply_target_event(&mut self, method: &str, params: &Value) -> Option<String> {
        let info = &params["targetInfo"];
        if info["type"] != "page" {
            return None;
        }
        let new = self.upsert_page(info);
        let id = info["targetId"].as_str()?;
        let awaited =
            method == "Target.targetCreated" && new && self.pending_follow.as_deref() == Some(id);
        if !awaited {
            return None;
        }
        self.pending_follow = None;
        self.may_follow().then(|| id.to_owned()) // owned: used after the lock
    }

    /// The tab list when it differs from the last one handed out.
    pub fn tabs_if_changed(&mut self) -> Option<&[TabInfo]> {
        let active = self.active.as_ref().map(|a| a.target_id.as_str());
        let tabs: Vec<TabInfo> = self
            .pages
            .iter()
            .map(|p| TabInfo {
                target_id: p.target_id.clone(), // the event owns its payload
                title: p.title.clone(),         // same
                url: p.url.clone(),             // same
                active: Some(p.target_id.as_str()) == active,
            })
            .collect();
        if tabs == self.published_tabs {
            return None;
        }
        self.published_tabs = tabs;
        Some(&self.published_tabs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inner_400x300() -> Inner {
        let mut inner = Inner::new();
        inner.size = Size::new(400, 300, 2.0).unwrap();
        inner
    }

    #[test]
    fn size_is_range_checked() {
        assert!(Size::new(400, 300, 2.0).is_ok());
        for (w, h, dpr) in [
            (0, 300, 1.0),
            (400, 0, 1.0),
            (9000, 300, 1.0),
            (400, 300, 0.0),
            (400, 300, 9.0),
        ] {
            assert!(Size::new(w, h, dpr).is_err(), "{w}x{h}@{dpr}");
        }
        assert_eq!(Size::new(400, 300, 1.5).unwrap().px(400), 600);
    }

    #[test]
    fn a_frame_of_the_wrong_size_asks_for_one_restart_at_a_time_and_not_forever() {
        let mut inner = inner_400x300();
        assert!(!inner.frame_needs_restart(400, 300, true), "right size");
        assert!(inner.frame_needs_restart(1280, 657, true), "window surface");
        assert!(
            !inner.frame_needs_restart(1280, 600, true),
            "one is pending"
        );
        for _ in 1..MAX_HEALS {
            inner.restart_started();
            assert!(inner.frame_needs_restart(1280, 657, true));
        }
        inner.restart_started();
        assert!(!inner.frame_needs_restart(1280, 657, true), "gave up");
        inner.last_restart = Instant::now().checked_sub(HEAL_REFILL);
        assert!(
            inner.frame_needs_restart(1280, 657, true),
            "the budget refills over time"
        );
        inner.restart_started();
        for _ in 1..MAX_HEALS {
            inner.restart_started();
            assert!(inner.frame_needs_restart(1280, 657, true));
        }
        inner.restart_started();
        assert!(!inner.frame_needs_restart(1280, 657, true), "gave up again");
        assert!(!inner.frame_needs_restart(400, 300, true));
        assert!(
            inner.frame_needs_restart(1280, 657, true),
            "a right frame re-arms it"
        );
    }

    #[test]
    fn a_panel_sized_label_on_a_mismatched_image_asks_for_a_restart() {
        let mut inner = inner_400x300();
        assert!(
            inner.frame_needs_restart(400, 300, false),
            "the window surface under the panel's metadata"
        );
    }

    #[test]
    fn restarts_are_spaced() {
        let mut inner = inner_400x300();
        assert_eq!(
            inner.restart_wait(),
            Duration::ZERO,
            "the first is immediate"
        );
        inner.restart_started();
        let wait = inner.restart_wait();
        assert!(wait > Duration::ZERO && wait <= HEAL_GAP, "{wait:?}");
        inner.last_restart = Instant::now().checked_sub(HEAL_GAP);
        assert_eq!(inner.restart_wait(), Duration::ZERO);
    }

    #[test]
    fn pages_are_updated_in_place_and_new_ones_reported() {
        let mut inner = Inner::new();
        let info = json!({ "targetId": "t1", "title": "A", "url": "about:blank" });
        assert!(inner.upsert_page(&info));
        let renamed = json!({ "targetId": "t1", "title": "B", "url": "https://x.test/" });
        assert!(!inner.upsert_page(&renamed));
        assert_eq!(inner.pages.len(), 1);
        assert_eq!(inner.pages[0].title, "B");
        assert!(!inner.upsert_page(&json!({ "title": "no id" })));
    }

    #[test]
    fn tabs_are_handed_out_only_when_they_changed() {
        let mut inner = Inner::new();
        assert!(inner.tabs_if_changed().is_none(), "no tabs, nothing to say");
        inner.upsert_page(&json!({ "targetId": "t1", "title": "A", "url": "u" }));
        inner.set_active("t1", "s");
        let tabs = inner.tabs_if_changed().unwrap();
        assert_eq!((tabs.len(), tabs[0].active), (1, true));
        assert!(inner.tabs_if_changed().is_none(), "unchanged");
        inner.active = None;
        assert!(
            !inner.tabs_if_changed().unwrap()[0].active,
            "the active mark is part of it"
        );
    }

    #[test]
    fn following_waits_for_open_and_for_the_users_choice_to_age() {
        let mut inner = Inner::new();
        assert!(!inner.may_follow(), "not before open finished");
        inner.following = true;
        assert!(inner.may_follow());
        inner.user_activated = Some(Instant::now());
        assert!(!inner.may_follow(), "the user just picked a tab");
        inner.user_activated = Instant::now().checked_sub(FOLLOW_HOLD);
        assert!(inner.may_follow(), "the choice is old enough");
    }

    fn page(id: &str) -> Value {
        json!({ "targetId": id, "type": "page", "title": "", "url": "u" })
    }

    fn created(id: &str) -> (&'static str, Value) {
        ("Target.targetCreated", json!({ "targetInfo": page(id) }))
    }

    /// A model of page `a`, shown, following.
    fn following_a() -> Inner {
        let mut inner = Inner::new();
        inner.upsert_page(&page("a"));
        inner.set_active("a", "sa");
        inner.following = true;
        inner
    }

    #[test]
    fn a_listed_page_is_followed_at_once() {
        let mut inner = following_a();
        inner.upsert_page(&page("b"));
        assert!(inner.request_follow("b"));
        assert!(inner.pending_follow.is_none());
    }

    #[test]
    fn a_page_not_listed_yet_is_followed_when_it_appears() {
        let mut inner = following_a();
        assert!(!inner.request_follow("b"), "not there yet");
        let (method, params) = created("c");
        assert_eq!(inner.apply_target_event(method, &params), None, "not it");
        let (method, params) = created("b");
        assert_eq!(
            inner.apply_target_event(method, &params).as_deref(),
            Some("b")
        );
        assert_eq!(inner.apply_target_event(method, &params), None, "once");
    }

    #[test]
    fn only_the_latest_unknown_page_is_waited_for() {
        let mut inner = following_a();
        assert!(!inner.request_follow("b"));
        assert!(!inner.request_follow("c"));
        let (method, params) = created("b");
        assert_eq!(inner.apply_target_event(method, &params), None);
        let (method, params) = created("c");
        assert_eq!(
            inner.apply_target_event(method, &params).as_deref(),
            Some("c")
        );
    }

    #[test]
    fn the_users_choice_holds_a_follow_back() {
        let mut inner = following_a();
        inner.upsert_page(&page("b"));
        inner.user_activated = Some(Instant::now());
        assert!(!inner.request_follow("b"), "held");
        assert!(inner.pending_follow.is_none(), "and not kept for later");
        inner.user_activated = Instant::now().checked_sub(FOLLOW_HOLD);
        assert!(inner.request_follow("b"), "the hold is over");
        // A page that shows up after the hold came back is held again.
        assert!(!inner.request_follow("c"));
        inner.user_activated = Some(Instant::now());
        let (method, params) = created("c");
        assert_eq!(inner.apply_target_event(method, &params), None);
    }

    #[test]
    fn target_events_update_pages_without_following_them() {
        let mut inner = following_a();
        let (method, params) = created("b");
        assert_eq!(inner.apply_target_event(method, &params), None);
        assert_eq!(inner.pages.len(), 2, "listed, though not followed");
        let renamed = json!({
            "targetInfo": { "targetId": "b", "type": "page", "title": "B", "url": "u2" }
        });
        assert_eq!(
            inner.apply_target_event("Target.targetInfoChanged", &renamed),
            None
        );
        assert_eq!(inner.pages[1].title, "B");
        let worker = json!({ "targetInfo": { "targetId": "w", "type": "service_worker" } });
        inner.apply_target_event("Target.targetCreated", &worker);
        assert_eq!(inner.pages.len(), 2, "pages only");
    }

    #[test]
    fn every_activation_has_its_own_generation() {
        let mut inner = Inner::new();
        let first = inner.set_active("a", "sa");
        let second = inner.set_active("a", "sa2");
        assert_ne!(first, second);
        assert_eq!(inner.active.as_ref().unwrap().generation, second);
    }
}
