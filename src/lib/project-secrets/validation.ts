/**
 * Request validation for project secrets. Pure, so it is safe to unit-test and
 * cannot accidentally pull a server-only dependency into a client bundle.
 *
 * The rules mirror what a `process.env` entry can hold: an identifier-shaped
 * name and text that is non-empty, NUL-free and bounded in bytes. Error messages
 * never echo the submitted value.
 */

import { isValidSecretName } from "@/lib/env-parse";

export const SECRET_NAME_MAX_LENGTH = 128;
export const SECRET_VALUE_MAX_BYTES = 32 * 1024;

export const SECRET_ENVIRONMENTS = ["development", "production", "both"] as const;
export type SecretEnvironment = (typeof SECRET_ENVIRONMENTS)[number];

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const NAME_ERROR =
  "Secret names must start with a letter or underscore and contain only letters, numbers and underscores (max 128 characters).";
const VALUE_ERROR = "Secret values must be non-empty text under 32 KB.";
const ENVIRONMENT_ERROR =
  "Environment must be development, production or both.";

export function validateSecretName(raw: unknown): Validation<string> {
  if (typeof raw !== "string") return { ok: false, error: NAME_ERROR };
  const name = raw.trim();
  if (name.length > SECRET_NAME_MAX_LENGTH || !isValidSecretName(name)) {
    return { ok: false, error: NAME_ERROR };
  }
  return { ok: true, value: name };
}

export function validateSecretValue(raw: unknown): Validation<string> {
  if (typeof raw !== "string") return { ok: false, error: VALUE_ERROR };
  if (raw.length === 0 || raw.includes("\u0000")) {
    return { ok: false, error: VALUE_ERROR };
  }
  if (Buffer.byteLength(raw, "utf8") > SECRET_VALUE_MAX_BYTES) {
    return { ok: false, error: VALUE_ERROR };
  }
  return { ok: true, value: raw };
}

export function validateSecretEnvironment(raw: unknown): Validation<SecretEnvironment> {
  if (typeof raw !== "string" || !SECRET_ENVIRONMENTS.includes(raw as SecretEnvironment)) {
    return { ok: false, error: ENVIRONMENT_ERROR };
  }
  return { ok: true, value: raw as SecretEnvironment };
}

export interface CreateSecretInput {
  secretName: string;
  secretValue: string;
  environment: SecretEnvironment;
}

export function validateCreateSecretInput(body: unknown): Validation<CreateSecretInput> {
  const record = recordOf(body);
  const name = validateSecretName(record.secretName);
  if (!name.ok) return name;
  const value = validateSecretValue(record.secretValue);
  if (!value.ok) return value;
  const environment = validateSecretEnvironment(record.environment);
  if (!environment.ok) return environment;

  return {
    ok: true,
    value: {
      secretName: name.value,
      secretValue: value.value,
      environment: environment.value,
    },
  };
}

export interface UpdateSecretInput {
  secretName?: string;
  secretValue?: string;
  environment?: SecretEnvironment;
}

/**
 * An update may change any subset, but must change something. A value-only
 * update is the normal replacement flow: the current value is never read back.
 */
export function validateUpdateSecretInput(body: unknown): Validation<UpdateSecretInput> {
  const record = recordOf(body);
  const patch: UpdateSecretInput = {};

  if (record.secretName !== undefined) {
    const name = validateSecretName(record.secretName);
    if (!name.ok) return name;
    patch.secretName = name.value;
  }

  if (record.secretValue !== undefined) {
    const value = validateSecretValue(record.secretValue);
    if (!value.ok) return value;
    patch.secretValue = value.value;
  }

  if (record.environment !== undefined) {
    const environment = validateSecretEnvironment(record.environment);
    if (!environment.ok) return environment;
    patch.environment = environment.value;
  }

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: "Provide a new secret value, name or environment.",
    };
  }

  return { ok: true, value: patch };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
