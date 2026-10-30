/**
 * ═══ END-USER AUTH HANDLERS FOR A GENERATED APP ════════════════════════════
 *
 * Registration, login, logout and session lookup. Sessions live in the
 * CUSTOMER's Neon database (`_mavly_auth_users`, `_mavly_auth_sessions`), not in
 * Mavly's Supabase project, so a generated app's users are never Mavly users.
 *
 * ⚠️ THE SESSION TOKEN IS THE END USER'S OWN. It is returned in the JSON body so
 * a cross-site generated app can use `Authorization: Bearer`, and it is also set
 * as an HttpOnly, Secure, project-scoped cookie for same-site deployments. It is
 * NOT a Mavly credential and it cannot reach any Mavly table.
 *
 * ⚠️ LOGIN FAILURES ARE GENERIC AND COST-UNIFORM. A missing account still runs
 * one scrypt verification, so response timing does not enumerate accounts.
 *
 * ⚠️ PASSWORD RESET IS NOT IMPLEMENTED. There is no email transport in this
 * repository, and a fake "reset" flow would be worse than none. The operator
 * documentation names this as a blocked capability.
 */

import { quoteIdentifier } from "@/lib/managed-backend/model";
import {
  AUTH_SESSIONS_TABLE,
  AUTH_USERS_TABLE,
} from "@/lib/managed-backend/migrations";

import {
  clearedSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  passwordProblem,
  sessionCookie,
  SESSION_TTL_SECONDS,
  SESSION_TOKEN_PATTERN,
  sessionExpiry,
  verifyPassword,
} from "./auth";
import { originAllowed } from "./cors";
import {
  admit,
  gatewayFail,
  gatewayOk,
  resolveApp,
  withDatabase,
  type GatewayResponse,
  type ResolvedApp,
} from "./context";

export interface AuthUser {
  id: string;
  email: string;
}

/** One dummy hash, created once, for a cost-uniform unknown-account check. */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("mavly-dummy-account-password-0000");
  return dummyHashPromise;
}

export async function resolveSessionUser(
  app: ResolvedApp,
  token: string | null,
): Promise<AuthUser | null> {
  if (!app.model.auth.required) return null;
  if (!token || !SESSION_TOKEN_PATTERN.test(token)) return null;

  const outcome = await withDatabase(app.connectionUri, async (client) => {
    const result = await client.query<{ id: string; email: string }>(
      `select u.${quoteIdentifier("id")}, u.${quoteIdentifier("email")}
         from ${quoteIdentifier(AUTH_SESSIONS_TABLE)} s
         join ${quoteIdentifier(AUTH_USERS_TABLE)} u
           on u.${quoteIdentifier("id")} = s.${quoteIdentifier("user_id")}
        where s.${quoteIdentifier("token_hash")} = $1
          and s.${quoteIdentifier("revoked_at")} is null
          and s.${quoteIdentifier("expires_at")} > now()
        limit 1`,
      [hashSessionToken(token)],
    );
    return result.rows[0] ?? null;
  });
  return outcome.ok ? outcome.data : null;
}

function readCredentials(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const email = normalizeEmail(record.email);
  const password = record.password;
  if (!email || typeof password !== "string") return null;
  return { email, password };
}

async function issueSession(
  app: ResolvedApp,
  user: AuthUser,
): Promise<GatewayResponse | null> {
  const token = createSessionToken();
  const outcome = await withDatabase(app.connectionUri, async (client) => {
    /** Bounded opportunistic prune: never an unbounded delete in a request. */
    await client.query(
      `delete from ${quoteIdentifier(AUTH_SESSIONS_TABLE)}
        where ctid in (
          select ctid from ${quoteIdentifier(AUTH_SESSIONS_TABLE)}
           where ${quoteIdentifier("expires_at")} < now() - interval '1 day'
           limit 100
        )`,
    );
    await client.query(
      `insert into ${quoteIdentifier(AUTH_SESSIONS_TABLE)}
         (${quoteIdentifier("user_id")}, ${quoteIdentifier("token_hash")}, ${quoteIdentifier("expires_at")})
       values ($1, $2, $3)`,
      [user.id, hashSessionToken(token), sessionExpiry()],
    );
  });
  if (outcome.ok === false) return outcome.response;

  const cookie = sessionCookie(app.projectId, token);
  return gatewayOk(
    { user: { id: user.id, email: user.email }, token, expiresIn: SESSION_TTL_SECONDS },
    200,
    cookie ? [cookie] : undefined,
  );
}

export async function handleAuth(input: {
  projectId: string;
  action: string;
  method: string;
  origin: string | null;
  body: unknown;
  sessionToken: string | null;
}): Promise<GatewayResponse> {
  const resolved = await resolveApp(input.projectId);
  if (resolved.ok === false) return resolved.response;
  const app = resolved.app;

  if (!app.model.auth.required) {
    return gatewayFail(
      404,
      "not_found",
      "This application does not use managed end-user accounts.",
    );
  }

  const action = input.action;
  const mutating = action === "signup" || action === "login" || action === "logout";
  if (mutating) {
    if (input.method !== "POST") {
      return gatewayFail(405, "method_not_allowed", "Use POST for this action.");
    }
    /**
     * The bearer token is CSRF-immune. A cookie-authenticated logout is not, so
     * a browser mutation must come from the project's own origin.
     */
    if (input.origin !== null && !originAllowed(app.projectId, input.origin)) {
      return gatewayFail(403, "origin_not_allowed", "This origin is not allowed.");
    }
  } else if (action === "session") {
    if (input.method !== "GET") {
      return gatewayFail(405, "method_not_allowed", "Use GET for this action.");
    }
  } else {
    return gatewayFail(404, "not_found", "Not found.");
  }

  /** A session read is a read; only credential attempts use the auth budget. */
  const limited = await admit(app.projectId, action === "session" ? "read" : "auth");
  if (limited) return limited;

  if (action === "signup") {
    if (!app.model.auth.allowSignup) {
      return gatewayFail(
        403,
        "signup_disabled",
        "This application does not allow self-service registration.",
      );
    }
    const credentials = readCredentials(input.body);
    if (!credentials) {
      return gatewayFail(422, "invalid_input", "A valid email and password are required.");
    }
    const problem = passwordProblem(credentials.password, credentials.email);
    if (problem) return gatewayFail(422, "invalid_password", problem);

    const passwordHash = await hashPassword(credentials.password);
    const outcome = await withDatabase(app.connectionUri, async (client) => {
      const result = await client.query<{ id: string; email: string }>(
        `insert into ${quoteIdentifier(AUTH_USERS_TABLE)}
           (${quoteIdentifier("email")}, ${quoteIdentifier("password_hash")})
         values ($1, $2)
         returning ${quoteIdentifier("id")}, ${quoteIdentifier("email")}`,
        [credentials.email, passwordHash],
      );
      return result.rows[0] ?? null;
    });
    if (outcome.ok === false) {
      // The unique index on lower(email) surfaces as 23505 → 409 conflict.
      return outcome.response;
    }
    if (!outcome.data) {
      return gatewayFail(500, "error", "The account could not be created.");
    }
    return (await issueSession(app, outcome.data)) ?? gatewayFail(
      500,
      "error",
      "The session could not be created.",
    );
  }

  if (action === "login") {
    const credentials = readCredentials(input.body);
    const stored = await withDatabase(app.connectionUri, async (client) => {
      const result = await client.query<{ id: string; email: string; password_hash: string }>(
        `select ${quoteIdentifier("id")}, ${quoteIdentifier("email")}, ${quoteIdentifier("password_hash")}
           from ${quoteIdentifier(AUTH_USERS_TABLE)}
          where lower(${quoteIdentifier("email")}) = lower($1)
          limit 1`,
        [credentials?.email ?? ""],
      );
      return result.rows[0] ?? null;
    });
    if (stored.ok === false) return stored.response;

    const password = credentials?.password ?? "";
    let valid = false;
    if (stored.data) {
      valid = await verifyPassword(password, stored.data.password_hash);
    } else {
      // One scrypt verification keeps the unknown-account path cost-similar.
      await verifyPassword(password, await dummyHash());
    }
    if (!credentials || !stored.data || !valid) {
      return gatewayFail(401, "invalid_credentials", "The email or password is incorrect.");
    }
    return (await issueSession(app, { id: stored.data.id, email: stored.data.email })) ??
      gatewayFail(500, "error", "The session could not be created.");
  }

  if (action === "logout") {
    const token = input.sessionToken;
    if (token && SESSION_TOKEN_PATTERN.test(token)) {
      const outcome = await withDatabase(app.connectionUri, async (client) => {
        await client.query(
          `update ${quoteIdentifier(AUTH_SESSIONS_TABLE)}
              set ${quoteIdentifier("revoked_at")} = now()
            where ${quoteIdentifier("token_hash")} = $1
              and ${quoteIdentifier("revoked_at")} is null`,
          [hashSessionToken(token)],
        );
      });
      if (outcome.ok === false) return outcome.response;
    }
    const cookie = clearedSessionCookie(app.projectId);
    return gatewayOk({ loggedOut: true }, 200, cookie ? [cookie] : undefined);
  }

  // `session`
  const user = await resolveSessionUser(app, input.sessionToken);
  return gatewayOk({ authenticated: user !== null, user });
}
