# Phase 15 — AWS customer frontend hosting (RETIRED)

> **STATUS: RETIRED / HISTORICAL.** Mavly removed the AWS customer frontend
> hosting implementation. Vercel is the only customer frontend hosting provider;
> see [Phase 17](phase-17-domain-publishing.md) and
> [`docs/runbooks/vercel-customer-hosting.md`](../runbooks/vercel-customer-hosting.md).
>
> Do not use this document to configure S3, CloudFront, a CloudFront
> KeyValueStore, a distribution, a certificate or a publication worker. None of
> that code exists in this repository any more, and no environment variable from
> this phase is read.

## What was removed

The retired implementation published an immutable static version to a private S3
bucket and routed `<project-id>.mavly.xyz` through a CloudFront KeyValueStore.
Removed with it:

- `src/lib/aws/` (configuration, eligibility, S3 client and publisher, tenant
  mapping, publication store, publication worker, publication observability);
- the AWS domain-routing provider;
- the AWS publication tick in the generation worker;
- every AWS frontend hosting environment variable;
- the `@aws-sdk/client-s3` and `@aws-sdk/client-cloudfront-keyvaluestore`
  dependencies;
- the staging infrastructure template.

No application code selects AWS, reads an AWS hosting variable or calls an AWS
frontend API.

## What is preserved

- **AWS EC2 generation worker.** `workers/aws-generation-worker.ts`,
  `infra/aws-generation-worker/`, `MAVLY_AWS_WORKER` and the worker runbook are
  unrelated to frontend hosting and stay operational. Generation, OpenRouter,
  checkpoints, leases and the durable queue are unchanged.
- **Historical data.** `project_deployments` rows with `provider = 'aws'`,
  published versions, published files, domain rows and their recorded
  `aws_cloudfront` routing metadata are kept. No row is deleted, rewritten or
  silently switched to Vercel.
- **Applied SQL.** Migrations 51, 56 and 61 remain applied and their functions
  stay installed but uncalled. Migration 65 records the retirement, settles
  attempts that could never finish, and adds
  `aws_frontend_hosting_retirement_schema_version()`.

## What an archived AWS row means today

- `GET …/deployments/status` returns the **recorded** state. Mavly does not probe
  AWS, so it neither claims the site is down nor re-verifies it.
- `POST …/deployments/deploy` refuses with `503 HOSTING_PROVIDER_RETIRED`: the
  project must be migrated to Vercel before it can be published again.
- `POST …/deployments/unpublish` refuses with the same code and states plainly
  that the site has **not** been reported as unpublished. Removing the old AWS
  route is an operator action.

## Migrating an archived site

No bulk migration exists and nothing switches automatically. Migration is an
explicit, owner-approved, operator-run action: publish the same source on Vercel,
verify the Vercel hostname serves it, then move the deployment row to
`provider = 'vercel'` (service role) and keep the old route until the new one is
proven. Never delete the AWS publication history, and never claim an AWS site was
migrated or taken down without doing it.
