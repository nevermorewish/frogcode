use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::claude::get_claude_dir;

fn get_bundled_skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|dir| dir.join("bundled-skills"))
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))
}

pub fn install_default_skills(app: &AppHandle) -> Result<(), String> {
    let skills_dir = get_claude_dir()
        .map_err(|e| format!("Failed to get Claude directory: {}", e))?
        .join("skills");

    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Failed to create skills directory {}: {}", skills_dir.display(), e))?;

    let bundled_skills_dir = get_bundled_skills_dir(app)?;
    if !bundled_skills_dir.exists() {
        log::warn!(
            "Bundled skills directory not found, skipping default skill install: {}",
            bundled_skills_dir.display()
        );
        return Ok(());
    }

    let entries = fs::read_dir(&bundled_skills_dir).map_err(|e| {
        format!(
            "Failed to read bundled skills directory {}: {}",
            bundled_skills_dir.display(),
            e
        )
    })?;

    let mut discovered = 0usize;
    let mut installed = 0usize;
    let mut skipped = 0usize;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read bundled skill entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect bundled skill entry type: {}", e))?;

        if !file_type.is_dir() {
            continue;
        }

        let skill_name = entry.file_name().to_string_lossy().to_string();
        let source_file = entry.path().join("SKILL.md");
        if !source_file.is_file() {
            continue;
        }

        discovered += 1;

        let target_dir = skills_dir.join(&skill_name);
        let target_file = target_dir.join("SKILL.md");

        if target_file.exists() {
            skipped += 1;
            continue;
        }

        fs::create_dir_all(&target_dir).map_err(|e| {
            format!(
                "Failed to create target skill directory {}: {}",
                target_dir.display(),
                e
            )
        })?;

        fs::copy(&source_file, &target_file).map_err(|e| {
            format!(
                "Failed to copy bundled skill {} to {}: {}",
                source_file.display(),
                target_file.display(),
                e
            )
        })?;

        installed += 1;
    }

    log::info!(
        "Default skills sync finished: {} discovered, {} installed, {} skipped",
        discovered,
        installed,
        skipped
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// OpenClaw bundled skills & plugins
// ---------------------------------------------------------------------------

/// Get the OpenClaw state root: ~/.frogcode/openclaw/state
fn openclaw_state_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(home.join(".frogcode").join("openclaw").join("state"))
}

/// Recursively copy an entire directory tree from `src` to `dst`.
/// Existing files are **not** overwritten so user modifications are preserved.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(usize, usize), String> {
    let mut installed = 0usize;
    let mut skipped = 0usize;

    fs::create_dir_all(dst).map_err(|e| {
        format!("Failed to create directory {}: {}", dst.display(), e)
    })?;

    let entries = fs::read_dir(src).map_err(|e| {
        format!("Failed to read directory {}: {}", src.display(), e)
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        let ft = entry
            .file_type()
            .map_err(|e| format!("Failed to get file type for {}: {}", src_path.display(), e))?;

        if ft.is_dir() {
            let (sub_i, sub_s) = copy_dir_recursive(&src_path, &dst_path)?;
            installed += sub_i;
            skipped += sub_s;
        } else {
            if dst_path.exists() {
                skipped += 1;
            } else {
                fs::copy(&src_path, &dst_path).map_err(|e| {
                    format!(
                        "Failed to copy {} -> {}: {}",
                        src_path.display(),
                        dst_path.display(),
                        e
                    )
                })?;
                installed += 1;
            }
        }
    }

    Ok((installed, skipped))
}

/// Install bundled OpenClaw skills to `~/.frogcode/openclaw/state/skills/`
/// and bundled OpenClaw plugins to `~/.frogcode/openclaw/state/extensions/`.
///
/// Unlike Claude skills (only SKILL.md), OpenClaw skills and plugins are
/// copied as full directory trees.  Existing files are never overwritten so
/// user modifications are preserved.
pub fn install_openclaw_defaults(app: &AppHandle) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

    let state_dir = openclaw_state_dir()?;

    // --- Skills ---
    let bundled_skills = resource_dir.join("bundled-openclaw-skills");
    if bundled_skills.exists() {
        let target_skills = state_dir.join("skills");
        fs::create_dir_all(&target_skills).map_err(|e| {
            format!(
                "Failed to create OpenClaw skills directory {}: {}",
                target_skills.display(),
                e
            )
        })?;

        let mut discovered = 0usize;
        let mut total_installed = 0usize;
        let mut total_skipped = 0usize;

        let entries = fs::read_dir(&bundled_skills).map_err(|e| {
            format!(
                "Failed to read bundled OpenClaw skills directory: {}",
                e
            )
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            if !entry
                .file_type()
                .map_err(|e| format!("file_type error: {}", e))?
                .is_dir()
            {
                continue;
            }

            discovered += 1;
            let name = entry.file_name();
            let dst = target_skills.join(&name);
            let (i, s) = copy_dir_recursive(&entry.path(), &dst)?;
            total_installed += i;
            total_skipped += s;
        }

        log::info!(
            "OpenClaw skills sync: {} skills discovered, {} files installed, {} files skipped",
            discovered,
            total_installed,
            total_skipped
        );
    } else {
        log::warn!(
            "Bundled OpenClaw skills not found at {}, skipping",
            bundled_skills.display()
        );
    }

    // --- Plugins (extensions) ---
    let bundled_plugins = resource_dir.join("bundled-openclaw-plugins");
    if bundled_plugins.exists() {
        let target_extensions = state_dir.join("extensions");
        fs::create_dir_all(&target_extensions).map_err(|e| {
            format!(
                "Failed to create OpenClaw extensions directory {}: {}",
                target_extensions.display(),
                e
            )
        })?;

        let mut discovered = 0usize;
        let mut total_installed = 0usize;
        let mut total_skipped = 0usize;

        let entries = fs::read_dir(&bundled_plugins).map_err(|e| {
            format!(
                "Failed to read bundled OpenClaw plugins directory: {}",
                e
            )
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            if !entry
                .file_type()
                .map_err(|e| format!("file_type error: {}", e))?
                .is_dir()
            {
                continue;
            }

            discovered += 1;
            let name = entry.file_name();
            let dst = target_extensions.join(&name);
            let (i, s) = copy_dir_recursive(&entry.path(), &dst)?;
            total_installed += i;
            total_skipped += s;
        }

        log::info!(
            "OpenClaw plugins sync: {} plugins discovered, {} files installed, {} files skipped",
            discovered,
            total_installed,
            total_skipped
        );
    } else {
        log::warn!(
            "Bundled OpenClaw plugins not found at {}, skipping",
            bundled_plugins.display()
        );
    }

    // --- Ensure the default workspace directory exists ---
    // The IM bridge uses ~/.openclaw/workspace as the default cwd for Claude
    // Code sessions.  Create it eagerly so the first Feishu message doesn't
    // fail because the directory is missing.
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let workspace = home.join(".openclaw").join("workspace");
    if !workspace.exists() {
        fs::create_dir_all(&workspace).map_err(|e| {
            format!(
                "Failed to create default workspace {}: {}",
                workspace.display(),
                e
            )
        })?;
        log::info!("Created default OpenClaw workspace: {}", workspace.display());
    }

    Ok(())
}
