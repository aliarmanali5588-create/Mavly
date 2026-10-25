export type ApiKeyEnv = "live" | "dev" | "both";

const ALLOWED_SCOPES = new Set(["db:read", "db:write", "db:schema", "integrations:*"]);

export function validateCreateApiKeyInput(body: unknown): { ok: true; value: { name: string; scopes: string[]; env: ApiKeyEnv } } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0 || name.length > 64) {
    return { ok: false, error: "Key name must be between 1 and 64 characters." };
  }
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) {
    return { ok: false, error: "Key name contains invalid characters." };
  }
  const env = record.env;
  if (env !== "live" && env !== "dev" && env !== "both") {
    return { ok: false, error: "Invalid environment." };
  }
  let scopes: unknown[] = [];
  if (Array.isArray(record.scopes)) {
    scopes = record.scopes;
  } else {
    return { ok: false, error: "Scopes are required." };
  }
  if (scopes.length === 0 || scopes.length > 32) {
    return { ok: false, error: "Invalid scopes." };
  }
  const out: string[] = [];
  for (const s of scopes) {
    if (typeof s !== "string") return { ok: false, error: "Invalid scopes." };
    if (!ALLOWED_SCOPES.has(s)) return { ok: false, error: "Invalid scope." };
    out.push(s);
  }
  // Dedupe
  const unique = Array.from(new Set(out));
  return { ok: true, value: { name, scopes: unique, env } };
}
