# Runbook — agent memory (Phase 8)

## Preconditions

- `supabase/migrations/24_agent_memory.sql` applied after 23.
- `MAVLY_AGENT_MEMORY_ENABLED=on` and an explicit
  `MAVLY_AGENT_MEMORY_PROJECTS` cohort (never `*`).
- Supabase URL/anon key configured. No new secret is required.
- The project owner is signed in; memory is never served to anon or another project.

Without the flag/cohort, persistent memory, retrieval selection and plan requests
are disabled, the memory API refuses, and generation uses the existing full-file
context/provider pipeline. With
the flag on but migration 24 missing, the API returns a truthful configuration
error and generation still runs with derived facts/selected files or its prior
full-file context.

## Staged rollout

1. Apply migration 24. Confirm `agent_memory_schema_version()` returns 24.
2. Enable one disposable project in the cohort. Open **More → Project memory**.
3. Confirm derived repository facts, an empty list and working add/edit/archive/
   delete/clear controls.
4. Add a decision that would be observable in generation (for example, an API
   compatibility constraint). Run a small update and confirm `[memory]`
   `context_built` logs a non-zero count and no memory content.
5. Run a generation that fails terminally. Confirm exactly one `observed` failure
   note appears for that run (worker: service-client write; inline: owner-checked
   `record_run_failure_memory` derived from the run row), contains only an error
   class and explicitly says the root cause is not verified.
6. Confirm a different signed-in user cannot list or mutate this project’s memory.
7. Disable the cohort/flag for one run and confirm generation still completes with
   the pre-Phase-8 behavior; memory rows remain.
8. Widen the cohort only after the checks.

Stop conditions: any cross-project memory response, any secret-shaped content
accepted, memory shown as an authorization/readiness signal, a stale/failed edit
overwriting a newer decision, or generation failing because the memory store is
unavailable. Disable the flag and investigate; rows can be archived/cleared by the
owner.

## What to watch

- `[memory] memory.context_built` — used=true, count, duration; no content.
- `[memory] memory.unavailable` — reason (`migration_required`, `unavailable`,
  `context_failed`, `record_failed`); generation must continue.
- `[memory] memory.recorded` — a decision or a terminal failure note.
- `[memory] memory.skipped` / `invalid` — disabled or rejected records.
- Existing `[generation]` events for the run outcome; memory never overwrites them.

## Recovery

- **Memory disabled/cohort removed:** generation returns to the existing behavior;
  no customer data is deleted. Re-enable with the same flag/cohort and rows remain.
- **Migration missing:** apply 24; no memory API writes succeed before it. Generation
  is not blocked.
- **Wrong/stale decision:** edit it in **Project memory** (revision required), or
  archive/delete it. Current files and the latest user request remain authoritative
  even before the edit.
- **Failure note is noisy/wrong:** delete it; it is an observation, not a root-cause
  finding. Do not edit it into a decision.
- **Memory store outage:** generation should continue with derived facts/selected
  files; check Supabase and the `[memory]` reason. Do not disable files/snapshots.
- **Suspected secret in memory:** delete the row, rotate the affected credential
  through its real owner (project secret/provider), and review the API path. The
  write validator should have refused it; investigate rather than copying it.
- **Clear memory:** delete/archive individual rows or use **Clear project memory**
  (explicit confirmation). This deletes memory rows only; files, snapshots,
  deployments and secrets are untouched.

## Human acceptance checklist

1. Run `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` yourself
   (the implementation agent did not run them).
2. Apply 24 after 23; check the schema marker.
3. Enable one cohort project; verify the panel and list API.
4. Add a decision, reload, edit it once, confirm a stale revision is refused, then
   approve/archive/reject as applicable.
5. Confirm memory text reaches the existing planner/batch prompts with the
   “context only / not instructions” framing; confirm current files are still
   included and authoritative. Do not expect a second model call.
6. Confirm terminal failures create one observed note and success/cancel do not.
7. Confirm secrets/emails/private keys/connection strings are refused.
8. Confirm project B cannot read/write project A memory (signed-in non-owner).
9. Confirm flag-off generation is unchanged and memory rows persist.
10. Inspect `[memory]` logs for content-free fields.

## Known limitations

- Keyword/path/import retrieval, not semantic search; no embedding provider.
- Facts are derived, not persisted/audited.
- Decisions do not auto-invalidate on file changes; the owner manages them.
- No automatic decision extraction from prompts.
- The memory UI and RLS/migration have not been exercised live by the implementation
  agent; no retrieval-quality or token/latency benchmark exists.
