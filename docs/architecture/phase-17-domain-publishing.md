# Phase 17 — Domain publishing on Vercel

**Status:** implemented server-side; **not activated** and **not verified live**.
Vercel commercial eligibility for Mavly-managed customer hosting is still
unconfirmed, so `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` must stay `false` in
production. No automated check was run to produce this document.

## Authority model

| Question | Authority |
|---|---|
| Which provider serves a project? | `project_deployments.provider` (a row's provider is never rewritten implicitly) |
| Which Vercel project may a hostname attach to? | `project_deployments.vercel_project_id` / `vercel_project_name`, read through the caller's RLS client |
| Is a custom hostname allowed? | `project_domains` (migration 62) uniqueness, ownership and plan limits |
| Is a hostname verified? | Vercel's project-domain response — never the UI, never a click |
| Is HTTPS live? | An actual HTTPS probe performed by the worker |
| Is a domain active? | `complete_domain_job` (service-role only) |
| Is a published version active? | `activate_vercel_publication` (migration 64, owner-checked) |

## Two publishing addresses

**Mavly subdomain** — `<project-id>.mavly.xyz`, derived from the immutable project
id by `src/lib/mavly-hostname.ts`. It is attached to the project's own Vercel
project by the publish path. It is not a `project_domains` row.

**Custom domain** — a customer-owned hostname stored in `project_domains`. The
owner registers it; the durable domain job attaches it to the same Vercel project,
asks Vercel to verify it, probes HTTPS, and only then records `active`.

A deployment reaching `READY` is **not** a verified domain, and a verified domain
is **not** a serving site. The three states are stored separately
(`status`, `dns_status`, `ssl_status`) and rendered separately.

## DNS records

`GET /api/vcaas/projects/{id}/domains/{domainId}/dns` returns the records Vercel
actually requires for that hostname. The response is a projection of Vercel's
project-domain `verification` entries: type, full record name and value are copied
verbatim; only the record type is normalised. There is no fallback CNAME, A value
or TXT token in the code. When Vercel returns nothing, the response says so.

The endpoint is read-only. It never attaches, verifies or activates anything, so a
page refresh cannot advance domain state.

## Gap B — published-version registry

Migration 62 claims a domain job only when `active_version_id` points at an ACTIVE
`project_published_versions` row. The shared publish path writes that pair; the
Vercel static path did not, so custom domains failed with
`DOMAIN_PROJECT_NOT_PUBLISHED`.

The Vercel publish now records the exact bytes it shipped as an immutable version
and activates it through migration 64's `activate_vercel_publication`. The call is
best-effort **after** the site is live: a storage or migration failure logs a
warning and never reports a successful publish as failed. Its consequence is
explicit — custom-domain jobs will keep refusing until a publish records a
version.

## Gap A — no second publication queue

The removed AWS publication queue is **not** replaced. The Vercel path keeps its
existing inline publish with the `beginDeployment` CAS claim, stale-claim
takeover and admission window. Domain provisioning is durable and separate
(migration 62's job table, 5-minute leases, 15 s → 300 s backoff, 10 attempts, dead
letter). No claim is made that the deploy itself is queue-backed.

## DNS infrastructure (operator)

`*.mavly.xyz` must resolve for the per-project hostnames, and the root
`mavly.xyz` records must stay untouched. Wildcard DNS alone does **not** make a
Mavly hostname verified on Vercel: each hostname is attached to its project and
Vercel must report it verified, after which HTTPS is provisioned asynchronously.
Custom domains are attached to the same project and require the records returned
by the DNS endpoint above.

## Rollback

Drop the trigger and function `sync_domain_routing_provider`, drop
`activate_vercel_publication` and the marker function. Recorded
`active_version_id` values are ordinary published-version references and need no
cleanup. No table, column or policy is added, so nothing must be restored.

## Known limitations

- No live Vercel deployment, domain attach, DNS propagation or certificate
  provisioning was exercised.
- The custom-domain modal registers the hostname and then triggers the publish;
  the worker retries the attach until the project's Vercel project exists.
- Admin and owner surfaces show the recorded provider, which migration 64 now
  derives from the deployment instead of stamping `aws_cloudfront`.
