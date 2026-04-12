//! Event sink abstraction used by the CLI runners.
//!
//! The desktop binary (`frog-code`) wires these through Tauri's `AppHandle::emit`,
//! while the web binary (`frogcode-web`) forwards them over a WebSocket envelope.
//! Both paths share the same `cli_runner.rs` execution code — the sink is the
//! only thing that changes between transports.

use serde::Serialize;
use std::sync::Arc;

/// An object-safe event sink. Payloads arrive already serialized as JSON text
/// so the trait stays dyn-compatible (generics on the method would break that).
pub trait EventSink: Send + Sync {
    /// Emit an event whose payload is a pre-serialized JSON string.
    fn emit_json(&self, event: &str, payload_json: String);
}

/// Convenience helpers that accept any `Serialize` value and delegate to
/// `emit_json`. Provided as a blanket impl so callers can just `use EventSinkExt`
/// and write `sink.emit("name", &value)`.
pub trait EventSinkExt: EventSink {
    fn emit<T: Serialize + ?Sized>(&self, event: &str, payload: &T) {
        match serde_json::to_string(payload) {
            Ok(s) => self.emit_json(event, s),
            Err(e) => log::warn!("EventSink: failed to serialize payload for '{}': {}", event, e),
        }
    }
}
impl<T: EventSink + ?Sized> EventSinkExt for T {}

/// Desktop / Tauri implementation. Wraps an `AppHandle` and forwards the
/// payload through Tauri's event bus, preserving the existing event names
/// the frontend already listens on.
pub struct TauriEventSink {
    handle: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(handle: tauri::AppHandle) -> Self {
        Self { handle }
    }
}

impl EventSink for TauriEventSink {
    fn emit_json(&self, event: &str, payload_json: String) {
        use tauri::Emitter;
        // Forward as a JSON Value so Tauri re-serializes with the correct
        // envelope on the receiving end. Fall back to the raw string if the
        // incoming text isn't valid JSON (shouldn't happen in practice).
        match serde_json::from_str::<serde_json::Value>(&payload_json) {
            Ok(value) => {
                let _ = self.handle.emit(event, value);
            }
            Err(_) => {
                let _ = self.handle.emit(event, payload_json);
            }
        }
    }
}

/// WebSocket implementation. Bundles the event+payload into a single JSON
/// envelope and drops it onto an mpsc channel that the WS writer task drains.
/// `try_send` is used so a slow reader can never block the execution loop.
pub struct WsEventSink {
    pub tx: tokio::sync::mpsc::Sender<String>,
}

impl WsEventSink {
    pub fn new(tx: tokio::sync::mpsc::Sender<String>) -> Self {
        Self { tx }
    }
}

impl EventSink for WsEventSink {
    fn emit_json(&self, event: &str, payload_json: String) {
        let envelope = match serde_json::from_str::<serde_json::Value>(&payload_json) {
            Ok(value) => serde_json::json!({ "event": event, "payload": value }),
            Err(_) => serde_json::json!({ "event": event, "payload": payload_json }),
        };
        let text = envelope.to_string();
        if let Err(e) = self.tx.try_send(text) {
            log::warn!("WsEventSink: dropping event '{}' ({})", event, e);
        }
    }
}

/// A no-op sink, useful for tests and for code paths that don't need to
/// emit anything.
pub struct NullEventSink;
impl EventSink for NullEventSink {
    fn emit_json(&self, _event: &str, _payload_json: String) {}
}

/// Shared handle type used across the codebase.
pub type SharedEventSink = Arc<dyn EventSink>;
