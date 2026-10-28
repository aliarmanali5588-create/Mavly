/**
 * ═══ CREDIT SYSTEM CONFIGURATION — OPT-IN, COHORT-SCOPED, OFF BY DEFAULT ═══════
 *
 *   MAVLY_CREDITS_ENABLED           1 / true / yes / on
 *   MAVLY_CREDITS_PROJECTS          comma/semicolon separated project ids
 *                                    (never `*`; an empty cohort disables credits)
 *   MAVLY_CREDITS_GENERATION_COST   whole credits reserved per generation run
 *                                    (1..100000). No default: without it the
 *                                    feature is not configured and charges nothing.
 *
 * No generation charge exists in this build unless ALL THREE are valid. That is
 * deliberate: there is no Mavly credit-funding flow yet, so enabling a charge
 * without an operator decision would block every generation.
 *
 * ⚠️ CREDITS ARE WHOLE UNITS. The approved credit packages and every workspace
 * surface use whole credits; this module refuses a fractional or non-integer
 * amount instead of silently rounding money.
 *
 * Pure: no Supabase, no network, no clock.
 */

export const CREDITS_ENABLED_ENV = "MAVLY_CREDITS_ENABLED";
export const CREDITS_PROJECTS_ENV = "MAVLY_CREDITS_PROJECTS";
export const CREDITS_GENERATION_COST_ENV = "MAVLY_CREDITS_GENERATION_COST";

/** The unit every credit balance in this system is expressed in. */
export const CREDIT_UNIT = "credits" as const;

/** Hard bound mirrored by migration 31's `INVALID_CREDIT_AMOUNT` guard. */
export const MAX_CREDITS_PER_RUN = 100_000;

/** Never a wildcard; an oversized cohort is truncated like the other cohorts. */
export const MAX_CREDITS_COHORT = 500;

export type CreditsProblem =
  | "disabled"
  | "missing_cohort"
  | "invalid_cohort"
  | "missing_cost"
  | "invalid_cost";

export interface CreditsConfig {
  /** The operator asked for credits (flag is truthy). */
  requested: boolean;
  /** Every prerequisite is valid; generation may reserve and settle credits. */
  ready: boolean;
  cohort: string[];
  /** Whole credits per run, or null when not configured. */
  generationCost: number | null;
  problems: CreditsProblem[];
}

export type CreditsEnvironment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(raw: string): string[] {
  const unique: string[] = [];
  for (const entry of raw.split(/[,;]+/).map((item) => item.trim().toLowerCase())) {
    if (entry && !unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, MAX_CREDITS_COHORT);
}

function parseCost(raw: string | undefined): { value: number | null; problem: CreditsProblem | null } {
  const text = (raw ?? "").trim();
  if (!text) return { value: null, problem: "missing_cost" };
  if (!/^\d+$/.test(text)) return { value: null, problem: "invalid_cost" };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CREDITS_PER_RUN) {
    return { value: null, problem: "invalid_cost" };
  }
  return { value, problem: null };
}

/**
 * Parse the whole configuration. `requested` is true for ANY truthy flag, even
 * when other prerequisites are missing, so a half-configured deployment can
 * report the exact problem instead of silently behaving as if credits were
 * never asked for.
 */
export function creditsConfig(env: CreditsEnvironment = process.env): CreditsConfig {
  const requested = isOn(env[CREDITS_ENABLED_ENV]);
  if (!requested) {
    return {
      requested: false,
      ready: false,
      cohort: [],
      generationCost: null,
      problems: ["disabled"],
    };
  }

  const problems: CreditsProblem[] = [];
  const rawCohort = (env[CREDITS_PROJECTS_ENV] ?? "").trim();
  const cohort = rawCohort ? splitCohort(rawCohort) : [];
  if (!cohort.length) problems.push("missing_cohort");
  if (rawCohort === "*" || cohort.includes("*")) problems.push("invalid_cohort");
  if (cohort.some((entry) => /\s/.test(entry))) problems.push("invalid_cohort");

  const cost = parseCost(env[CREDITS_GENERATION_COST_ENV]);
  if (cost.problem) problems.push(cost.problem);

  const uniqueProblems = [...new Set(problems)];
  return {
    requested: true,
    ready: uniqueProblems.length === 0,
    cohort: uniqueProblems.includes("invalid_cohort") ? [] : cohort,
    generationCost: cost.value,
    problems: uniqueProblems,
  };
}

export function isProjectInCreditsCohort(
  projectId: string | null | undefined,
  config: CreditsConfig,
): boolean {
  const project = projectId?.trim().toLowerCase();
  return !!project && config.cohort.includes(project);
}

/**
 * The credits the server should reserve for this project's next run, or null
 * when credits do not apply. The browser never supplies this number.
 */
export function creditCostForProject(
  projectId: string | null | undefined,
  env: CreditsEnvironment = process.env,
): number | null {
  const config = creditsConfig(env);
  if (!config.ready || config.generationCost === null) return null;
  return isProjectInCreditsCohort(projectId, config) ? config.generationCost : null;
}

/** A truthful, secret-free reason for a disabled/unready configuration. */
export function creditsProblemMessage(problem: CreditsProblem): string {
  switch (problem) {
    case "disabled":
      return "Credits are disabled in this deployment.";
    case "missing_cohort":
      return "Credits need an explicit MAVLY_CREDITS_PROJECTS cohort.";
    case "invalid_cohort":
      return "The credits cohort is invalid; wildcard and whitespace entries are refused.";
    case "missing_cost":
      return "Credits need a whole MAVLY_CREDITS_GENERATION_COST amount.";
    case "invalid_cost":
      return "MAVLY_CREDITS_GENERATION_COST must be a whole number between 1 and 100000.";
  }
}
