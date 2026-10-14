//! The panel's pointer and keyboard input, mapped 1:1 to CDP `Input.*`.

use serde::Deserialize;
use serde_json::{json, Value};

/// What the frontend sends for a user gesture on the page image
/// (coordinates are CSS pixels of the page).
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputEvent {
    #[serde(rename_all = "camelCase")]
    Mouse {
        r#type: String,
        x: f64,
        y: f64,
        button: String,
        buttons: u32,
        click_count: u32,
        modifiers: u32,
    },
    #[serde(rename_all = "camelCase")]
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: u32,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        r#type: String,
        key: String,
        code: String,
        text: Option<String>,
        modifiers: u32,
        windows_virtual_key_code: u32,
    },
    Text {
        text: String,
    },
}

const MOUSE_TYPES: [&str; 3] = ["mousePressed", "mouseReleased", "mouseMoved"];
const MOUSE_BUTTONS: [&str; 6] = ["none", "left", "middle", "right", "back", "forward"];
const KEY_TYPES: [&str; 4] = ["keyDown", "keyUp", "rawKeyDown", "char"];

fn one_of(what: &str, value: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("invalid {what} {value:?}"))
    }
}

impl InputEvent {
    /// The CDP method and params for this event; refuses values CDP has no
    /// meaning for.
    pub fn to_command(&self) -> Result<(&'static str, Value), String> {
        match self {
            Self::Mouse {
                r#type,
                x,
                y,
                button,
                buttons,
                click_count,
                modifiers,
            } => {
                one_of("mouse type", r#type, &MOUSE_TYPES)?;
                one_of("mouse button", button, &MOUSE_BUTTONS)?;
                Ok((
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": r#type, "x": x, "y": y, "button": button,
                        "buttons": buttons, "clickCount": click_count,
                        "modifiers": modifiers,
                    }),
                ))
            }
            Self::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                modifiers,
            } => Ok((
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel", "x": x, "y": y,
                    "deltaX": delta_x, "deltaY": delta_y, "modifiers": modifiers,
                }),
            )),
            Self::Key {
                r#type,
                key,
                code,
                text,
                modifiers,
                windows_virtual_key_code,
            } => {
                one_of("key type", r#type, &KEY_TYPES)?;
                let mut params = json!({
                    "type": r#type, "key": key, "code": code, "modifiers": modifiers,
                    "windowsVirtualKeyCode": windows_virtual_key_code,
                });
                if let Some(text) = text {
                    params["text"] = Value::from(text.as_str());
                }
                Ok(("Input.dispatchKeyEvent", params))
            }
            Self::Text { text } => Ok(("Input.insertText", json!({ "text": text }))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> InputEvent {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn frontend_payloads_map_to_cdp_commands() {
        let (method, params) = parse(
            r#"{"kind":"mouse","type":"mousePressed","x":1.5,"y":2,"button":"left","buttons":1,"clickCount":1,"modifiers":0}"#,
        )
        .to_command()
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["clickCount"], 1);
        assert_eq!(params["x"], 1.5);

        let (method, params) =
            parse(r#"{"kind":"wheel","x":1,"y":2,"deltaX":0,"deltaY":-120,"modifiers":0}"#)
                .to_command()
                .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["type"], "mouseWheel");
        assert_eq!(params["deltaY"], -120.0);

        let (method, params) = parse(
            r#"{"kind":"key","type":"keyDown","key":"a","code":"KeyA","text":"a","modifiers":0,"windowsVirtualKeyCode":65}"#,
        )
        .to_command()
        .unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(params["windowsVirtualKeyCode"], 65);
        assert_eq!(params["text"], "a");

        let (method, params) = parse(r#"{"kind":"text","text":"abc"}"#)
            .to_command()
            .unwrap();
        assert_eq!(
            (method, &params["text"]),
            ("Input.insertText", &json!("abc"))
        );
    }

    #[test]
    fn key_without_text_sends_none() {
        let (_, params) = parse(
            r#"{"kind":"key","type":"keyUp","key":"Shift","code":"ShiftLeft","text":null,"modifiers":8,"windowsVirtualKeyCode":16}"#,
        )
        .to_command()
        .unwrap();
        assert!(params.get("text").is_none());
    }

    #[test]
    fn unknown_types_and_buttons_are_refused() {
        let bad_type = parse(
            r#"{"kind":"mouse","type":"explode","x":0,"y":0,"button":"left","buttons":0,"clickCount":0,"modifiers":0}"#,
        );
        assert!(bad_type.to_command().is_err());
        let bad_button = parse(
            r#"{"kind":"mouse","type":"mouseMoved","x":0,"y":0,"button":"thumb","buttons":0,"clickCount":0,"modifiers":0}"#,
        );
        assert!(bad_button.to_command().is_err());
        let bad_key = parse(
            r#"{"kind":"key","type":"press","key":"a","code":"KeyA","text":null,"modifiers":0,"windowsVirtualKeyCode":65}"#,
        );
        assert!(bad_key.to_command().is_err());
    }
}
