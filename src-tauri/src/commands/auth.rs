use reqwest::Client;
use serde::{Deserialize, Serialize};
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
