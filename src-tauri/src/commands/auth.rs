use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const FROGCLAW_BASE_URL: &str = "https://frogclaw.com";

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

#[derive(Debug, Serialize, Deserialize)]
struct TokenListResponse {
    items: Option<Vec<FrogclawToken>>,
    total: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FrogclawLoginSession {
    pub user: UserData,
    pub tokens: Vec<FrogclawToken>,
    pub system_providers: Vec<FrogclawSystemProvider>,
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

#[tauri::command]
pub async fn fetch_frogclaw_providers(
    username: String,
    password: String,
) -> Result<FrogclawLoginSession, String> {
    // Create client with cookie store for session-based auth
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .cookie_store(true)
        .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Step 1: Login to establish session
    let login_url = format!("{}/api/user/login", FROGCLAW_BASE_URL);
    let login_resp = client
        .post(&login_url)
        .json(&LoginBody {
            username: username.clone(),
            password: password.clone(),
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

    let user_id = user.id.to_string();

    // Step 2: Fetch user's tokens
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
                .filter(|t| t.status == 1) // Only enabled tokens
                .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // Step 3: Fetch system CLI providers
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

    Ok(FrogclawLoginSession {
        user,
        tokens,
        system_providers,
    })
}
