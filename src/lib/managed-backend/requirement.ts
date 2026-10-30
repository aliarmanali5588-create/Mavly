/**
 * ═══ DOES THIS GENERATION NEED A PERSISTENT BACKEND? ════════════════════════
 *
 * The planner proposes; this module decides. The model is allowed to *recommend*
 * `requiresDatabase`, but a recommendation is not a provisioning authorization:
 *
 *   · a clearly static request (landing page, portfolio, one-pager) never gets a
 *     Neon project, even if the model asks for one;
 *   · a clearly persistent request that the model marked static is upgraded to
 *     `required` WITHOUT provisioning, because there is no validated data model
 *     to migrate. The run then reports exactly that instead of inventing a
 *     working backend or silently shipping in-memory storage.
 *
 * ⚠️ NOTHING HERE CREATES A DATABASE. This is a pure text decision over the
 * planner signal and the user prompt; `service.ts` performs provisioning only
 * after a validated `AppDataModel` exists.
 *
 * Pure: no I/O, no clock, no environment.
 */

export type BackendProjectType = "website" | "android";

export interface PlannerBackendSignal {
  requiresDatabase?: unknown;
  authentication?: unknown;
  reason?: unknown;
}

export interface BackendRequirementDecision {
  required: boolean;
  /** End-user accounts inside the generated app (never Mavly's own auth). */
  authentication: boolean;
  reason: string;
  /** True when the trusted server overrode the planner's own signal. */
  overridden: boolean;
  /** The prompt reads as a static/marketing artifact. */
  staticSite: boolean;
  /**
   * The prompt asks for persistence the planner did not plan. A database is not
   * provisioned until a valid data model exists, so callers must surface this.
   */
  modelMissing: boolean;
}

const STATIC_MARKERS =
  /\b(?:landing\s*page|one[-\s]?pager|single[-\s]?page|portfolio|brochure|marketing\s+(?:site|website)|static\s+(?:site|website|page|html)|read[-\s]?only|no\s+(?:backend|database|server)|without\s+(?:a\s+)?(?:backend|database)|prototype\s+only|demo\s+only|solo\s+maqueta)\b/i;

/**
 * Persistence markers are deliberately concrete: a noun that only makes sense
 * as a stored record, or an explicit save/auth verb. `dashboard` alone is not
 * enough — a static dashboard mock is a real product ask.
 */
const PERSISTENCE_MARKERS =
  /\b(?:save[ds]?|saving|persist(?:ent|ence)?|database|crud|records?|history|bookmarks?|todos?|to[-\s]?do\s+list|tasks?|notes?|bookings?|reservations?|orders?|invoices?|inventory|customers?|contacts?|leads?|posts|comments?|messages?|subscribers?|members?)\b/i;

const AUTH_MARKERS =
  /\b(?:log\s*-?\s*in|log\s*-?\s*out|sign\s*-?\s*up|sign\s*-?\s*in|register|authentication|authenticated|accounts?|private\s+(?:data|area|dashboard)|my\s+(?:account|profile|orders|tasks|notes)|password)\b/i;

/** A planner signal is data, so it is re-read defensively. */
function plannerBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function plannerReason(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

export function detectBackendRequirement(input: {
  prompt: string;
  planner: PlannerBackendSignal | null | undefined;
  projectType?: BackendProjectType;
}): BackendRequirementDecision {
  const prompt = typeof input.prompt === "string" ? input.prompt.slice(0, 20_000) : "";

  /**
   * Native Android source is text-only in this repository: there is no managed
   * backend binding for a generated APK and no runtime that could use one.
   */
  if (input.projectType === "android") {
    return {
      required: false,
      authentication: false,
      reason: "Native Android projects have no managed backend binding in Mavly.",
      overridden: false,
      staticSite: false,
      modelMissing: false,
    };
  }

  const planned = plannerBoolean(input.planner?.requiresDatabase) === true;
  const plannedAuth = plannerBoolean(input.planner?.authentication) === true;
  const staticSite = STATIC_MARKERS.test(prompt);
  const persistent = PERSISTENCE_MARKERS.test(prompt);
  const authAsked = AUTH_MARKERS.test(prompt);
  const reason = plannerReason(input.planner?.reason);

  if (planned && staticSite && !persistent) {
    return {
      required: false,
      authentication: false,
      reason:
        "The request reads as a static site with no stored data, so no managed database is provisioned.",
      overridden: true,
      staticSite,
      modelMissing: false,
    };
  }

  if (!planned && persistent && !staticSite) {
    return {
      required: true,
      authentication: authAsked,
      reason:
        reason ||
        "The request needs records that survive a page reload, so a managed backend is required.",
      overridden: true,
      staticSite,
      modelMissing: true,
    };
  }

  if (!planned) {
    return {
      required: false,
      authentication: false,
      reason: reason || "No persistent server-side data was requested.",
      overridden: false,
      staticSite,
      modelMissing: false,
    };
  }

  return {
    required: true,
    authentication: plannedAuth || authAsked,
    reason: reason || "The application needs persistent server-side data.",
    overridden: false,
    staticSite,
    modelMissing: false,
  };
}
