//! Native macOS window decorations; the webview remains the app toolbar.

#[cfg(target_os = "macos")]
pub fn configure(config: &mut tauri::utils::config::Config) {
    if let Some(window) = config.app.windows.iter_mut().find(|w| w.label == "main") {
        window.decorations = true;
        window.title_bar_style = tauri::TitleBarStyle::Overlay;
        window.hidden_title = true;
        // Tao/Wry use y to set the titlebar container's height, not directly
        // the button's top edge. With AppKit's 14pt buttons at local y=9,
        // 20.5 puts their centres at 18.5pt, the 38px toolbar's content centre.
        window.traffic_light_position =
            Some(tauri::utils::config::LogicalPosition { x: 12.0, y: 20.5 });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DoubleClickAction {
    Minimize,
    Zoom,
    None,
}

fn double_click_action(value: Option<&str>) -> DoubleClickAction {
    match value {
        Some("Minimize") => DoubleClickAction::Minimize,
        Some("None") => DoubleClickAction::None,
        // Missing preferences use the system's normal zoom behavior.
        _ => DoubleClickAction::Zoom,
    }
}

/// The overlaid toolbar honors the same user preference as a native title bar.
/// Reading it does not move, close, or otherwise mutate any window.
#[tauri::command]
pub fn window_titlebar_action() -> DoubleClickAction {
    #[cfg(target_os = "macos")]
    {
        use objc2_core_foundation::{CFPreferencesCopyAppValue, CFString};
        let key = CFString::from_static_str("AppleActionOnDoubleClick");
        let domain = CFString::from_static_str(".GlobalPreferences");
        let value = CFPreferencesCopyAppValue(&key, &domain);
        let text = value
            .as_ref()
            .and_then(|value| value.downcast_ref::<CFString>())
            .map(ToString::to_string);
        double_click_action(text.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    double_click_action(None)
}

#[cfg(test)]
mod tests {
    use super::{double_click_action, DoubleClickAction};

    #[test]
    fn double_click_follows_the_users_action_and_neutral_default() {
        assert_eq!(
            double_click_action(Some("Minimize")),
            DoubleClickAction::Minimize
        );
        assert_eq!(double_click_action(Some("None")), DoubleClickAction::None);
        for value in [None, Some("Maximize"), Some("Zoom"), Some("Fill")] {
            assert_eq!(double_click_action(value), DoubleClickAction::Zoom);
        }
    }
}
