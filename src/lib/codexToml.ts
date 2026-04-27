/**
 * Serialize the JSON `config.toml` subtree produced by the frogClaw backend
 * into TOML text matching the cc-switch reference template:
 *
 *   model_provider = "<name>"
 *   model = "<model>"
 *   model_reasoning_effort = "high"
 *   disable_response_storage = true
 *
 *   [model_providers.<name>]
 *   name = "<name>"
 *   base_url = "<url>"
 *   wire_api = "responses"
 *   requires_openai_auth = true
 *
 * Tightly scoped: handles only the shape frogClaw produces
 * (top-level scalars + a `model_providers` table of provider entries).
 * Strings are TOML-escaped; empty-string scalars are omitted so codex CLI
 * doesn't see `model = ""` (cc-switch behavior).
 */

const TOP_LEVEL_ORDER = [
  "model_provider",
  "model",
  "model_reasoning_effort",
  "disable_response_storage",
];

const PROVIDER_FIELD_ORDER = [
  "name",
  "base_url",
  "wire_api",
  "requires_openai_auth",
];

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function formatKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : `"${escapeString(key)}"`;
}

function formatScalar(value: unknown): string | null {
  if (typeof value === "string") {
    if (value === "") return null; // skip empty strings
    return `"${escapeString(value)}"`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function emitKv(key: string, value: unknown): string | null {
  const scalar = formatScalar(value);
  if (scalar === null) return null;
  return `${formatKey(key)} = ${scalar}`;
}

function orderedKeys(obj: Record<string, unknown>, preferred: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of preferred) {
    if (k in obj) {
      out.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(obj).sort()) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
}

export function serializeCodexConfigToml(
  config: Record<string, unknown> | null | undefined,
): string {
  if (!isPlainObject(config)) return "";

  const lines: string[] = [];

  // Top-level scalars (skip the `model_providers` table — handled below).
  for (const key of orderedKeys(config, TOP_LEVEL_ORDER)) {
    if (key === "model_providers") continue;
    const value = config[key];
    if (isPlainObject(value)) continue; // unexpected nested table — skip
    const kv = emitKv(key, value);
    if (kv !== null) lines.push(kv);
  }

  const providers = config.model_providers;
  if (isPlainObject(providers)) {
    const providerKeys = Object.keys(providers).sort();
    for (const providerKey of providerKeys) {
      const entry = providers[providerKey];
      if (!isPlainObject(entry)) continue;
      if (lines.length > 0) lines.push(""); // blank line before section
      lines.push(`[model_providers.${formatKey(providerKey)}]`);
      for (const field of orderedKeys(entry, PROVIDER_FIELD_ORDER)) {
        const value = entry[field];
        if (isPlainObject(value)) continue;
        const kv = emitKv(field, value);
        if (kv !== null) lines.push(kv);
      }
    }
  }

  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
