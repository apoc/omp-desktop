//! Ompy service client: one reconnecting connection, re-emitted as
//! `persona://` events, and the commands the Ompy tab and settings use.

mod client;
mod push;
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

pub fn refresh_sidecar() -> Result<(), String> {
    sidecar::refresh()
}

/// Queue one request and wait for the service's reply off Tauri's IPC thread:
/// `Client::request` blocks up to 10 s.
async fn request(persona: &State<'_, Persona>, body: ClientMsg) -> Result<(), String> {
    let client = persona.client.handle();
    crate::off_ipc(move || client.request(body)).await?
}

fn validate_send(json: &str) -> Result<serde_json::Value, String> {
    validate_command_type(json.trim_end_matches(['\r', '\n']))
}

// The status and inbox reads only take the client's snapshot mutex; they are
// deliberately synchronous (no service round trip).
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

/// The queued wakes and the next interval wake (`ClientMsg::ListSchedule`).
/// `Value::Null` when the service answers without data.
#[tauri::command]
pub async fn persona_schedule(persona: State<'_, Persona>) -> Result<serde_json::Value, String> {
    let client = persona.client.handle();
    crate::off_ipc(move || client.request_value(ClientMsg::ListSchedule)).await?
}

/// Open the persona instructions file in the user's editor. The service
/// writes it from its embedded default on start, so a missing file only
/// means Ompy has not run on this machine yet.
#[tauri::command]
pub async fn persona_open_instructions() -> Result<(), String> {
    crate::off_ipc(open_instructions).await?
}

fn open_instructions() -> Result<(), String> {
    let path = omp_desktop_core::persona_paths::Paths::resolve()?.instructions;
    if !path.is_file() {
        return Err(format!("Start Ompy once to create {}.", path.display()));
    }
    let _gate = crate::spawn_gate::shared();
    #[allow(clippy::disallowed_methods)] // launching the editor, under the gate
    open::that_detached(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))
}

#[tauri::command]
pub async fn persona_attach(after_seq: u64, persona: State<'_, Persona>) -> Result<(), String> {
    request(&persona, ClientMsg::Attach { after_seq }).await
}

#[tauri::command]
pub async fn persona_detach(persona: State<'_, Persona>) -> Result<(), String> {
    request(&persona, ClientMsg::Detach).await
}

#[tauri::command]
pub async fn persona_send(json: String, persona: State<'_, Persona>) -> Result<(), String> {
    let client = persona.client.handle();
    // Parsing a large frame belongs off the IPC thread too, next to the
    // blocking request that follows it.
    crate::off_ipc(move || {
        let frame = validate_send(&json)?;
        client.request(ClientMsg::Rpc { frame })
    })
    .await?
}

#[tauri::command]
pub async fn persona_resolve(
    id: String,
    answer: Option<String>,
    persona: State<'_, Persona>,
) -> Result<(), String> {
    request(&persona, ClientMsg::InboxResolve { id, answer }).await
}

#[tauri::command]
pub async fn persona_set_settings(
    settings: PersonaSettings,
    persona: State<'_, Persona>,
) -> Result<(), String> {
    request(&persona, ClientMsg::SetSettings { settings }).await
}

#[tauri::command]
pub async fn persona_pause(persona: State<'_, Persona>) -> Result<(), String> {
    request(&persona, ClientMsg::Pause).await
}

#[tauri::command]
pub async fn persona_resume(persona: State<'_, Persona>) -> Result<(), String> {
    request(&persona, ClientMsg::Resume).await
}

#[tauri::command]
pub async fn persona_wake_now(persona: State<'_, Persona>) -> Result<(), String> {
    request(&persona, ClientMsg::WakeNow).await
}

/// Install or remove the login sidecar (a `launchctl`/`schtasks` child run)
/// and reconnect, all off the IPC thread.
async fn set_installed(persona: &State<'_, Persona>, install: bool) -> Result<(), String> {
    let client = persona.client.handle();
    crate::off_ipc(move || {
        if install {
            sidecar::install()?;
        } else {
            sidecar::uninstall()?;
        }
        client.reconnect()
    })
    .await?
}

#[tauri::command]
pub async fn persona_enable(persona: State<'_, Persona>) -> Result<(), String> {
    set_installed(&persona, true).await
}

#[tauri::command]
pub async fn persona_disable(persona: State<'_, Persona>) -> Result<(), String> {
    set_installed(&persona, false).await
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
