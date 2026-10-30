use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use super::host::{source_project, EvidenceHost};
use super::media::{Artifact, AssetSource};
use super::presets::{DefaultScope, Library, Preset, PresetInput};

#[tauri::command]
pub async fn evidence_library(
    project_path: Option<String>,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<Library, String> {
    crate::with_blocking(&host, move |host| {
        let project = source_project(project_path.as_deref())?;
        Ok(host.presets.library(project.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn evidence_save_preset(
    preset: PresetInput,
    expected_revision: u64,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<Preset, String> {
    crate::with_blocking(&host, move |host| {
        host.presets.save(preset, expected_revision)
    })
    .await
}

#[tauri::command]
pub async fn evidence_assign_preset(
    scope: DefaultScope,
    preset_id: Option<String>,
    project_path: Option<String>,
    expected_revision: u64,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<(), String> {
    crate::with_blocking(&host, move |host| {
        let project = source_project(project_path.as_deref())?;
        host.presets.assign(
            scope,
            preset_id.as_deref(),
            project.as_deref(),
            expected_revision,
        )
    })
    .await
}

#[tauri::command]
pub async fn evidence_delete_preset(
    id: String,
    expected_revision: u64,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<(), String> {
    crate::with_blocking(&host, move |host| {
        host.presets.delete(&id, expected_revision)
    })
    .await
}

#[tauri::command]
pub fn evidence_snapshot(
    session_id: String,
    host: State<'_, Arc<EvidenceHost>>,
) -> Option<serde_json::Value> {
    host.snapshot(&session_id)
}

#[tauri::command]
pub async fn evidence_asset_source(
    session_id: String,
    artifact_id: String,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<AssetSource, String> {
    crate::with_blocking(&host, move |host| {
        host.asset_source(&session_id, &artifact_id)
    })
    .await
}

#[tauri::command]
pub async fn evidence_asset_text(
    session_id: String,
    artifact_id: String,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<serde_json::Value, String> {
    crate::with_blocking(&host, move |host| {
        host.asset_text(&session_id, &artifact_id)
    })
    .await
}

#[tauri::command]
pub async fn evidence_pick_artifact(
    session_id: String,
    window: tauri::WebviewWindow,
    host: State<'_, Arc<EvidenceHost>>,
) -> Result<Option<Artifact>, String> {
    // Pin the current conversation before opening the native modal dialog.
    let identity = host.pick_identity(&session_id)?;
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .dialog()
        .file()
        .set_title("Choose Evidence")
        .set_parent(&window)
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    crate::with_blocking(&host, move |host| {
        let Some(picked) = rx
            .recv()
            .map_err(|e| format!("Evidence picker failed: {e}"))?
        else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|e| format!("Invalid evidence file: {e}"))?;
        host.pick_artifact(&session_id, &path, identity).map(Some)
    })
    .await
}
