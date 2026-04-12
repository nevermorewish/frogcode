use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionSummary {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    pub message_count: usize,
    pub last_message_at: Option<String>,
    pub created_at: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub id: String,
    pub role: String,
    pub content: serde_json::Value,
    pub created_at: Option<String>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionDetail {
    pub summary: HistorySessionSummary,
    pub messages: Vec<HistoryMessage>,
}

fn openclaw_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let home = std::env::var("USERPROFILE").ok()?;
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".openclaw"))
}

/// Extract text from message content (string or array of blocks).
fn content_to_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            let mut parts = Vec::new();
            for block in arr {
                if let Some(obj) = block.as_object() {
                    if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                            parts.push(text.to_string());
                        }
                    }
                }
            }
            parts.join("\n")
        }
        _ => serde_json::to_string(content).unwrap_or_default(),
    }
}

/// Scan a single JSONL file and produce a summary.
fn scan_jsonl(file_path: &PathBuf, bot_id: &str) -> Option<HistorySessionSummary> {
    let file = fs::File::open(file_path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id = String::new();
    let mut created_at = String::new();
    let mut first_user_msg: Option<String> = None;
    let mut message_count: usize = 0;
    let mut last_message_at: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let obj: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let entry_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if entry_type == "session" {
            if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
                session_id = id.to_string();
            }
            if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                created_at = ts.to_string();
            }
        } else if entry_type == "message" {
            let msg = obj.get("message").unwrap_or(&obj);
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            message_count += 1;

            // Track timestamp
            if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                last_message_at = Some(ts.to_string());
            }

            // First user message as title
            if role == "user" && first_user_msg.is_none() {
                if let Some(content) = msg.get("content") {
                    let text = content_to_text(content);
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        let title = if text.len() > 80 {
                            format!("{}...", &text[..text.char_indices().take(80).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(80)])
                        } else {
                            text
                        };
                        first_user_msg = Some(title);
                    }
                }
            }
        }
    }

    // Use filename as fallback id
    if session_id.is_empty() {
        session_id = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
    }

    if message_count == 0 {
        return None;
    }

    Some(HistorySessionSummary {
        id: session_id,
        bot_id: bot_id.to_string(),
        title: first_user_msg.unwrap_or_else(|| "(no title)".to_string()),
        message_count,
        last_message_at,
        created_at,
        file_path: file_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn scan_openclaw_history_sessions() -> Result<Vec<HistorySessionSummary>, String> {
    tokio::task::spawn_blocking(|| {
        let oc_home = openclaw_home().ok_or("Cannot determine OpenClaw home directory")?;
        let agents_dir = oc_home.join("agents");
        if !agents_dir.exists() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();

        let entries = fs::read_dir(&agents_dir).map_err(|e| format!("read agents dir: {}", e))?;
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let bot_id = entry.file_name().to_string_lossy().to_string();
            let sessions_dir = entry.path().join("sessions");
            if !sessions_dir.exists() {
                continue;
            }

            let files = fs::read_dir(&sessions_dir).map_err(|e| format!("read sessions dir: {}", e))?;
            for file_entry in files.flatten() {
                let path = file_entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.ends_with(".jsonl") {
                    continue;
                }
                if let Some(summary) = scan_jsonl(&path, &bot_id) {
                    results.push(summary);
                }
            }
        }

        // Sort by created_at descending
        results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(results)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
pub async fn load_openclaw_history_session(file_path: String) -> Result<HistorySessionDetail, String> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let file = fs::File::open(&path).map_err(|e| format!("open file: {}", e))?;
        let reader = BufReader::new(file);

        let mut session_id = String::new();
        let mut created_at = String::new();
        let mut first_user_msg: Option<String> = None;
        let mut messages = Vec::new();
        let mut msg_index: usize = 0;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let obj: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let entry_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if entry_type == "session" {
                if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
                    session_id = id.to_string();
                }
                if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                    created_at = ts.to_string();
                }
            } else if entry_type == "message" {
                let msg = obj.get("message").unwrap_or(&obj);
                let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }

                let content = msg.get("content").cloned().unwrap_or(serde_json::Value::Null);
                let ts_str = obj.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());
                let ts_ms = msg.get("timestamp").and_then(|v| v.as_i64());

                if role == "user" && first_user_msg.is_none() {
                    let text = content_to_text(&content);
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        first_user_msg = Some(if text.len() > 80 {
                            format!("{}...", &text[..text.char_indices().take(80).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(80)])
                        } else {
                            text
                        });
                    }
                }

                let msg_id = obj.get("id").and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("msg-{}", msg_index));

                messages.push(HistoryMessage {
                    id: msg_id,
                    role: role.to_string(),
                    content,
                    created_at: ts_str,
                    timestamp: ts_ms,
                });
                msg_index += 1;
            }
        }

        if session_id.is_empty() {
            session_id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
        }

        let bot_id = path.parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let last_message_at = messages.last().and_then(|m| m.created_at.clone());

        let summary = HistorySessionSummary {
            id: session_id,
            bot_id,
            title: first_user_msg.unwrap_or_else(|| "(no title)".to_string()),
            message_count: messages.len(),
            last_message_at,
            created_at,
            file_path,
        };

        Ok(HistorySessionDetail { summary, messages })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}
