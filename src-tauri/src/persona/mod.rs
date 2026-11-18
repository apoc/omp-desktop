//! Ompy service client: one reconnecting connection, re-emitted as
//! `persona://` events, and the commands the Ompy tab and settings use.

mod client;
mod sidecar;

use crate::agent::validate_command_type;
use client::Client;
use omp_desktop_core::persona_protocol::{ClientMsg, InboxItem, PersonaSettings, StatusInfo};
use tauri::State;

pub struct Persona {
    client: Client,
}

impl Persona {
    pub fn for_app(app: tauri::AppHandle) -> Self {
        Self {
            client: Client::for_app(app),
        }
    }
}

fn validate_send(json: &str) -> Result<serde_json::Value, String> {
    validate_command_type(json.trim_end_matches(['\r', '\n']))
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // IPC contract: every persona command returns Result
pub fn persona_status(persona: State<'_, Persona>) -> Result<Option<StatusInfo>, String> {
    Ok(persona.client.status())
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // IPC contract: every persona command returns Result
pub fn persona_inbox(persona: State<'_, Persona>) -> Result<Vec<InboxItem>, String> {
    Ok(persona.client.inbox())
}

#[tauri::command]
pub fn persona_attach(after_seq: u64, persona: State<'_, Persona>) -> Result<(), String> {
    persona.client.request(ClientMsg::Attach { after_seq })
}

#[tauri::command]
pub fn persona_detach(persona: State<'_, Persona>) -> Result<(), String> {
    persona.client.request(ClientMsg::Detach)
}

#[tauri::command]
pub fn persona_send(json: String, persona: State<'_, Persona>) -> Result<(), String> {
    let frame = validate_send(&json)?;
    persona.client.request(ClientMsg::Rpc { frame })
}

#[tauri::command]
pub fn persona_resolve(
    id: String,
    answer: Option<String>,
    persona: State<'_, Persona>,
) -> Result<(), String> {
    persona
        .client
        .request(ClientMsg::InboxResolve { id, answer })
}

#[tauri::command]
pub fn persona_set_settings(
    settings: PersonaSettings,
    persona: State<'_, Persona>,
) -> Result<(), String> {
    persona.client.request(ClientMsg::SetSettings { settings })
}

#[tauri::command]
pub fn persona_pause(persona: State<'_, Persona>) -> Result<(), String> {
    persona.client.request(ClientMsg::Pause)
}

#[tauri::command]
pub fn persona_resume(persona: State<'_, Persona>) -> Result<(), String> {
    persona.client.request(ClientMsg::Resume)
}

#[tauri::command]
pub fn persona_wake_now(persona: State<'_, Persona>) -> Result<(), String> {
    persona.client.request(ClientMsg::WakeNow)
}

#[tauri::command]
pub fn persona_enable(persona: State<'_, Persona>) -> Result<(), String> {
    sidecar::install()?;
    persona.client.reconnect()
}

#[tauri::command]
pub fn persona_disable(persona: State<'_, Persona>) -> Result<(), String> {
    sidecar::uninstall()?;
    persona.client.reconnect()
}

#[cfg(test)]
mod tests {
    use super::validate_send;

    #[test]
    fn send_rejects_unknown_type() {
        assert_eq!(
            validate_send(r#"{"type":"rm"}"#).unwrap_err(),
            "command type 'rm' is not allowed"
        );
    }

    #[test]
    fn send_accepts_an_allowed_type() {
        assert_eq!(
            validate_send(r#"{"type":"prompt","message":"hi"}"#).unwrap()["type"],
            "prompt"
        );
    }
}
