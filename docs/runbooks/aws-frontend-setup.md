# Runbook: AWS customer frontend hosting — RETIRED

> **DO NOT USE.** This runbook configured S3, CloudFront, a CloudFront
> KeyValueStore, an ACM certificate and the AWS publication worker for customer
> frontend hosting. That implementation was removed from the repository.
>
> - Vercel customer hosting: [`vercel-customer-hosting.md`](vercel-customer-hosting.md)
> - Remaining AWS EC2 **generation** worker: [`aws-generation-worker.md`](aws-generation-worker.md)

## What to do on a deployment that still has these variables

Nothing in the application reads them any more. Remove them from `.env.local`,
the EC2 worker environment (`/etc/mavly/worker.env`) and the hosting provider's
environment settings:

```bash
grep -n '^MAVLY_AWS_FRONTEND_HOSTING\|^MAVLY_AWS_S3_BUCKET\|^MAVLY_AWS_REGION\|^MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN' .env.local || true
```

Do **not** remove `MAVLY_AWS_WORKER`. It activates the preserved AWS EC2
generation worker and has nothing to do with frontend hosting.

Removing the variables does not delete an S3 object, a CloudFront distribution,
a route, a DNS record or a live customer site. Those are infrastructure
resources and require a separate, explicitly approved operator change.

## Existing AWS-published customer sites

They are archived, not migrated. See
[Phase 15](../architecture/phase-15-aws-frontend-hosting.md) for what the
application now reports and for the explicit per-project migration procedure.

- Do not delete the old AWS route until the Vercel replacement is verified and
  serving.
- Do not change a `provider = 'aws'` row by hand to make the schema look clean.
- Do not claim an AWS site was migrated or taken down unless that was actually
  done and verified.

## Historical note

Migration 65 (`65_retire_aws_frontend_hosting.sql`) records the retirement and
marks AWS publication attempts that can never finish as `error`
(`aws_hosting_retired`). It deletes no data. The SQL from migrations 51, 56 and
61 stays installed but is no longer called by application code.
