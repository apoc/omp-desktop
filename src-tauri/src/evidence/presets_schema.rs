//! Preset wire types, immutable Standard, and bounded library schema.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

pub(super) const STANDARD_ID: &str = "standard";
const MAX_NAME_BYTES: usize = 120;
const MAX_PROMPT_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 64;
const MAX_PROJECT_BYTES: usize = 4096;
pub(super) const MAX_PRESETS: usize = 64;
pub(super) const MAX_PROJECTS: usize = 512;
pub(super) const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;
// JSON is consumed by JavaScript, so its revisions must remain exact numbers.
pub(super) const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Triggers {
    pub before_work: bool,
    pub after_changes: bool,
    pub before_handoff: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub planning_prompt: String,
    pub collection_prompt: String,
    pub assessment_prompt: String,
    pub triggers: Triggers,
    pub tracking: bool,
    pub handoff: String,
}

/// Only these fields are editable. A supplied `revision` is ignored; the
/// separately supplied expected revision guards the entire library instead.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub planning_prompt: String,
    pub collection_prompt: String,
    pub assessment_prompt: String,
    pub triggers: Triggers,
    pub tracking: bool,
    pub handoff: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedPolicy {
    pub preset: Preset,
    pub source: String,
    pub project: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub revision: u64,
    pub presets: Vec<Preset>,
    pub global_default: Option<String>,
    pub project_default: Option<String>,
    pub project: Option<String>,
    pub resolved: ResolvedPolicy,
    pub warning: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultScope {
    Global,
    Project,
}

pub(super) fn standard() -> Preset {
    Preset {
        id: STANDARD_ID.to_owned(),
        name: "Standard".to_owned(),
        revision: 1,
        planning_prompt: "Identify the user's intended outcomes and concrete acceptance criteria before work. Use the Evidence tool to record relevant outcomes and requirements; preserve user-owned requirements and ask when success is unclear. Keep evidence proportional to the change.".to_owned(),
        collection_prompt: "Collect inspectable evidence for each relevant requirement: observations, source references, test or execution receipts, screenshots, video, build/runtime output, or CI where available. Record what actually happened, its source and authorship, including failures and blocked or unavailable checks. A successful command receipt alone does not prove its output satisfies the requirement; do not invent evidence or capabilities.".to_owned(),
        assessment_prompt: "Assess each requirement against the recorded evidence and its source revision. Explain missing, stale, failed, blocked, or unreviewed evidence and limitations honestly. Do not accept or reject evidence, waive requirements, or weaken user-owned requirements on the user's behalf, and do not claim independent verification or production readiness without it.".to_owned(),
        triggers: Triggers {
            before_work: true,
            after_changes: true,
            before_handoff: true,
        },
        tracking: true,
        handoff: "advisory".to_owned(),
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PresetFile {
    pub(super) version: u8,
    pub(super) revision: u64,
    pub(super) presets: Vec<Preset>,
    pub(super) global_default: Option<String>,
    pub(super) projects: BTreeMap<String, String>,
}

impl Default for PresetFile {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            presets: Vec::new(),
            global_default: None,
            projects: BTreeMap::new(),
        }
    }
}

impl PresetFile {
    fn preset(&self, id: &str) -> Option<&Preset> {
        self.presets.iter().find(|preset| preset.id == id)
    }

    pub(super) fn contains(&self, id: &str) -> bool {
        id == STANDARD_ID || self.preset(id).is_some()
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.revision > MAX_REVISION {
            return Err("unsupported preset library version or revision".to_owned());
        }
        if self.presets.len() > MAX_PRESETS || self.projects.len() > MAX_PROJECTS {
            return Err("preset library exceeds its entry limit".to_owned());
        }
        let mut ids = HashSet::with_capacity(self.presets.len());
        for preset in &self.presets {
            validate_preset(preset)?;
            if preset.id == STANDARD_ID || !ids.insert(&preset.id) {
                return Err("preset library contains a built-in or duplicate id".to_owned());
            }
        }
        if self
            .global_default
            .as_deref()
            .is_some_and(|id| !self.contains(id))
        {
            return Err("global default refers to a missing preset".to_owned());
        }
        for (project, id) in &self.projects {
            validate_project(project)?;
            if !self.contains(id) {
                return Err("project default refers to a missing preset".to_owned());
            }
        }
        Ok(())
    }

    pub(super) fn resolve(&self, project: Option<&str>) -> ResolvedPolicy {
        let project_id = project.and_then(|key| self.projects.get(key));
        let (id, source) = project_id.map_or_else(
            || {
                self.global_default
                    .as_deref()
                    .map_or((None, "builtin"), |id| (Some(id), "global"))
            },
            |id| (Some(id.as_str()), "project"),
        );
        let preset = match id {
            Some(id) if id != STANDARD_ID => {
                // The resolved policy is an independently owned, pinned snapshot.
                self.preset(id).cloned().unwrap_or_else(standard)
            }
            _ => standard(),
        };
        ResolvedPolicy {
            preset,
            source: source.to_owned(),
            project: project.map(str::to_owned),
        }
    }
}

pub(super) fn validate_preset(preset: &Preset) -> Result<(), String> {
    if preset.id.is_empty()
        || preset.id.len() > MAX_ID_BYTES
        || !preset
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid preset id".to_owned());
    }
    if preset.revision == 0 || preset.revision > MAX_REVISION {
        return Err("invalid preset revision".to_owned());
    }
    if preset.name.trim().is_empty()
        || preset.name.len() > MAX_NAME_BYTES
        || preset.name.chars().any(char::is_control)
    {
        return Err(
            "preset name must be nonempty, single-line, and at most 120 UTF-8 bytes".to_owned(),
        );
    }
    if [
        &preset.planning_prompt,
        &preset.collection_prompt,
        &preset.assessment_prompt,
    ]
    .iter()
    .any(|prompt| prompt.len() > MAX_PROMPT_BYTES || prompt.contains('\0'))
    {
        return Err(
            "each preset prompt must be at most 4096 UTF-8 bytes and contain no NUL".to_owned(),
        );
    }
    if !matches!(preset.handoff.as_str(), "advisory" | "remind") {
        return Err("handoff must be advisory or remind".to_owned());
    }
    Ok(())
}

pub(super) fn validate_project(project: &str) -> Result<(), String> {
    if project.len() > MAX_PROJECT_BYTES
        || project.contains('\0')
        || !Path::new(project).is_absolute()
    {
        Err("a bounded absolute canonical source project is required".to_owned())
    } else {
        Ok(())
    }
}
