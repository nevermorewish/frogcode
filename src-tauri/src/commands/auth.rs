use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

const FROGCLAW_BASE_URL: &str = "https://frogclaw.com";

/// Append an auth event to the platform sidecar log so it appears in the
/// "日志" (Logs) page alongside other lifecycle events.
fn auth_log(event: &str, detail: &str) {
    let Some(home) = dirs::home_dir() else { return };
    let path = home.join(".frogcode").join("platform-sidecar.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] [auth {}] {}", ts, event, detail);
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserData {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: i64,
    pub status: i64,
    pub group: String,
}

#[derive(Debug, Deserialize)]
struct FrogclawResponse<T> {
    success: bool,
    message: String,
    data: Option<T>,
}

#[derive(Debug, Serialize)]
struct LoginBody {
    username: String,
    password: String,
}

// ==================== Frogclaw Token & Provider Types ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrogclawToken {
    pub id: i64,
    pub key: String,
    pub name: String,
    pub status: i64,
    pub remain_quota: i64,
    pub unlimited_quota: bool,
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrogclawSystemProvider {
    pub id: i64,
    pub name: String,
    pub provider_key: String,
    pub api_mode: String,
    pub needs_v1_suffix: bool,
    pub base_url: String,
    pub default_model: Option<String>,
    pub use_site_token: bool,
    pub token_group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrogclawCliProvider {
    pub id: i64,
    pub name: String,
    pub provider_type: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub settings_config: Option<String>,
    pub is_default: Option<bool>,
    pub created_time: Option<i64>,
    pub updated_time: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenListResponse {
    items: Option<Vec<FrogclawToken>>,
    total: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CliProviderListResponse {
    items: Option<Vec<FrogclawCliProvider>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FrogclawLoginSession {
    pub user: UserData,
    pub tokens: Vec<FrogclawToken>,
    pub system_providers: Vec<FrogclawSystemProvider>,
    pub cli_providers: Vec<FrogclawCliProvider>,
}

// ==================== Commands ====================

#[tauri::command]
pub async fn login_to_frogclaw(username: String, password: String) -> Result<UserData, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let login_url = format!("{}/api/user/login", FROGCLAW_BASE_URL);
    let login_resp = client
        .post(&login_url)
        .json(&LoginBody { username, password })
        .send()
        .await
        .map_err(|e| format!("Login request failed: {}", e))?;

    if !login_resp.status().is_success() {
        return Err(format!("Server error: {}", login_resp.status()));
    }

    let login_result: FrogclawResponse<UserData> = login_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse login response: {}", e))?;

    if !login_result.success {
        return Err(login_result.message);
    }

    login_result
        .data
        .ok_or_else(|| "Login succeeded but no user data returned".to_string())
}

/// Establish a session-authenticated client. Returns the http client and the logged-in user.
async fn login_and_client(
    username: &str,
    password: &str,
) -> Result<(Client, UserData), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .cookie_store(true)
        .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let login_url = format!("{}/api/user/login", FROGCLAW_BASE_URL);
    let login_resp = client
        .post(&login_url)
        .json(&LoginBody {
            username: username.to_string(),
            password: password.to_string(),
        })
        .send()
        .await
        .map_err(|e| format!("Login request failed: {}", e))?;

    if !login_resp.status().is_success() {
        return Err(format!("Server error: {}", login_resp.status()));
    }

    let login_result: FrogclawResponse<UserData> = login_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse login response: {}", e))?;

    if !login_result.success {
        return Err(login_result.message);
    }

    let user = login_result
        .data
        .ok_or_else(|| "Login succeeded but no user data returned".to_string())?;

    Ok((client, user))
}

/// Fetch tokens + system providers + cli providers for an authenticated session.
async fn fetch_session_data(
    client: &Client,
    user: UserData,
) -> Result<FrogclawLoginSession, String> {
    let user_id = user.id.to_string();

    let tokens_url = format!("{}/api/token/?p=0&size=100", FROGCLAW_BASE_URL);
    let tokens_resp = client
        .get(&tokens_url)
        .header("New-Api-User", &user_id)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch tokens: {}", e))?;

    let tokens: Vec<FrogclawToken> = if tokens_resp.status().is_success() {
        let result: FrogclawResponse<TokenListResponse> = tokens_resp
            .json()
            .await
            .unwrap_or(FrogclawResponse {
                success: false,
                message: String::new(),
                data: None,
            });
        if result.success {
            result
                .data
                .and_then(|d| d.items)
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t.status == 1)
                .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let providers_url = format!("{}/api/system-cli-provider/", FROGCLAW_BASE_URL);
    let providers_resp = client
        .get(&providers_url)
        .header("New-Api-User", &user_id)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch system providers: {}", e))?;

    let system_providers: Vec<FrogclawSystemProvider> = if providers_resp.status().is_success() {
        let result: FrogclawResponse<Vec<FrogclawSystemProvider>> = providers_resp
            .json()
            .await
            .unwrap_or(FrogclawResponse {
                success: false,
                message: String::new(),
                data: None,
            });
        if result.success {
            result.data.unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let cli_url = format!("{}/api/cli-provider/?p=0&page_size=100", FROGCLAW_BASE_URL);
    let cli_resp = client
        .get(&cli_url)
        .header("New-Api-User", &user_id)
        .send()
        .await;

    let cli_providers: Vec<FrogclawCliProvider> = match cli_resp {
        Ok(resp) if resp.status().is_success() => {
            let result: FrogclawResponse<CliProviderListResponse> = resp
                .json()
                .await
                .unwrap_or(FrogclawResponse {
                    success: false,
                    message: String::new(),
                    data: None,
                });
            if result.success {
                result.data.and_then(|d| d.items).unwrap_or_default()
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    };

    Ok(FrogclawLoginSession {
        user,
        tokens,
        system_providers,
        cli_providers,
    })
}

#[tauri::command]
pub async fn fetch_frogclaw_providers(
    username: String,
    password: String,
) -> Result<FrogclawLoginSession, String> {
    let (client, user) = login_and_client(&username, &password).await?;
    let user_id = user.id.to_string();
    auth_log("login", &format!("用户 {} ({}) 登录成功", user.username, user_id));

    let session = fetch_session_data(&client, user).await?;

    let oc_count = session
        .cli_providers
        .iter()
        .filter(|p| p.provider_type == "openclaw")
        .count();
    auth_log(
        "fetch",
        &format!(
            "获取完成: {} tokens, {} system providers, {} cli providers ({} openclaw)",
            session.tokens.len(),
            session.system_providers.len(),
            session.cli_providers.len(),
            oc_count
        ),
    );

    Ok(session)
}

#[tauri::command]
pub async fn ensure_frogclaw_group_token(
    username: String,
    password: String,
    group: String,
) -> Result<FrogclawLoginSession, String> {
    let group = if group.is_empty() { "default".to_string() } else { group };

    let (client, user) = login_and_client(&username, &password).await?;
    let user_id = user.id.to_string();

    #[derive(Serialize)]
    struct EnsureBody<'a> {
        group: &'a str,
    }

    let ensure_url = format!("{}/api/token/ensure-group", FROGCLAW_BASE_URL);
    let ensure_resp = client
        .post(&ensure_url)
        .header("New-Api-User", &user_id)
        .json(&EnsureBody { group: &group })
        .send()
        .await
        .map_err(|e| format!("ensure-group request failed: {}", e))?;

    if !ensure_resp.status().is_success() {
        return Err(format!(
            "ensure-group server error: {}",
            ensure_resp.status()
        ));
    }

    let ensure_result: FrogclawResponse<Value> = ensure_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse ensure-group response: {}", e))?;

    if !ensure_result.success {
        auth_log(
            "ensure-group",
            &format!("group={} 失败: {}", group, ensure_result.message),
        );
        return Err(ensure_result.message);
    }

    auth_log(
        "ensure-group",
        &format!("group={} 已新建/复用", group),
    );

    // Refetch everything so the frontend gets the new token in context.
    fetch_session_data(&client, user).await
}

#[tauri::command]
pub async fn apply_openclaw_config(config_json: String) -> Result<(), String> {
    let server_config: Value = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let config_dir = home.join(".frogcode").join("openclaw").join("config");
    let config_path = config_dir.join("openclaw.json");

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;

    // Read existing config to merge (preserve local-only fields)
    let mut existing: Value = if config_path.exists() {
        let raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read existing config: {}", e))?;
        serde_json::from_str(&raw).unwrap_or(Value::Object(serde_json::Map::new()))
    } else {
        Value::Object(serde_json::Map::new())
    };

    // Save local-only values that must survive the merge:
    //   gateway.port   — frogcode owns this
    //   plugins        — frogcode manages extensions dir
    //   agents.defaults.workspace — local workspace path
    let saved_gw_port = existing.pointer("/gateway/port").cloned();
    let saved_plugins = existing.get("plugins").cloned();
    let saved_workspace = existing.pointer("/agents/defaults/workspace").cloned();

    // Merge server config into existing (server wins for all keys)
    if let (Some(existing_obj), Some(server_obj)) = (existing.as_object_mut(), server_config.as_object()) {
        for (key, value) in server_obj {
            existing_obj.insert(key.clone(), value.clone());
        }
    }

    // Restore local-only values
    if let Some(port) = saved_gw_port {
        if let Some(obj) = existing.as_object_mut() {
            let gw = obj.entry("gateway").or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Some(gw_obj) = gw.as_object_mut() {
                gw_obj.insert("port".to_string(), port);
            }
        }
    }
    if let Some(pl) = saved_plugins {
        if let Some(obj) = existing.as_object_mut() {
            obj.insert("plugins".to_string(), pl);
        }
    }
    // Frogcode uses its own sidecar for feishu, not openclaw's built-in plugin.
    // Always disable openclaw's feishu plugin to avoid double-connecting.
    if let Some(plugins) = existing.pointer_mut("/plugins/entries/feishu") {
        if let Some(obj) = plugins.as_object_mut() {
            obj.insert("enabled".to_string(), Value::Bool(false));
        }
    }
    if let Some(ws) = saved_workspace {
        if let Some(obj) = existing.as_object_mut() {
            let agents = obj.entry("agents").or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Some(agents_obj) = agents.as_object_mut() {
                let defaults = agents_obj.entry("defaults").or_insert_with(|| Value::Object(serde_json::Map::new()));
                if let Some(defaults_obj) = defaults.as_object_mut() {
                    defaults_obj.insert("workspace".to_string(), ws);
                }
            }
        }
    }

    // Atomic write: temp file + rename
    let tmp_path = config_dir.join(format!("openclaw.json.tmp.{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()));
    let raw = serde_json::to_string_pretty(&existing)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&tmp_path, &raw)
        .map_err(|e| format!("Failed to write temp config: {}", e))?;

    // On Windows, remove old file first before rename
    if cfg!(windows) && config_path.exists() {
        let _ = std::fs::remove_file(&config_path);
    }
    std::fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("Failed to rename config: {}", e))?;

    auth_log("openclaw-config", &format!("已写入 openclaw.json -> {}", config_path.display()));
    Ok(())
}
