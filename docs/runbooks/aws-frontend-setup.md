# AWS frontend hosting setup and operations

## Status and stop conditions

This runbook prepares an operator to stage the AWS publisher. It does not certify a
production deployment. The repository has not been connected to an AWS account, and
the template, migration, worker role, certificate, DNS, and live requests remain
unverified.

**Do not change `*.mavly.xyz` DNS to CloudFront.** The current Function serves only
projects with AWS KVS entries. It has no fallback to existing shared-hosting or
Vercel sites, and no resumable migration utility has been implemented. A wildcard
cutover would make unmapped projects return 404. First implement and accept dual-read
compatibility and migrate every existing tenant.

Do not use this feature to replace an existing Vercel or shared deployment. The
application refuses that transition until a migration path exists.

## 1. Confirm prerequisites in the target AWS account

Use the real account and region already designated for the generation worker. Do not
choose a region based on an example in this repository.

```bash
aws sts get-caller-identity
aws configure list
```

Identify the existing EC2 instance and its instance profile using the operator's
actual instance identifier:

```bash
read -r -p "Existing generation worker EC2 instance ID: " INSTANCE_ID
aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].{State:State.Name,Region:Placement.AvailabilityZone,IamProfile:IamInstanceProfile.Arn}' \
  --output table
```

If the instance has no profile, stop and resolve that through the existing worker
deployment process. Do not create another EC2 instance, attach long-lived access keys,
or put AWS credentials in Vercel. The CloudFormation template attaches its narrow
policy to an **existing IAM role name**; it does not create an instance profile.

Confirm that the DNS provider for `mavly.xyz` is under operator control. Obtain or
request a DNS-validated ACM certificate for `*.mavly.xyz` in `us-east-1`. The
certificate must be `ISSUED` before a CloudFront distribution can use it.

## 2. Prepare the certificate

Request the certificate through ACM in `us-east-1`, with the exact domain
`*.mavly.xyz`. Complete the DNS validation records at the existing DNS provider.
Do not remove validation records after issuance.

Check status without printing credentials:

```bash
read -r -p "Wildcard certificate ARN: " CERTIFICATE_ARN
aws acm describe-certificate \
  --region us-east-1 \
  --certificate-arn "$CERTIFICATE_ARN" \
  --query 'Certificate.{Domain:DomainName,Status:Status,Validation:DomainValidationOptions[*].ValidationStatus}' \
  --output table
```

Proceed only when the certificate domain is `*.mavly.xyz` and status is `ISSUED`.
The certificate ARN is a resource identifier, not a secret.

## 3. Deploy the prepared CloudFormation stack in staging

Review [`infra/aws-frontend-hosting/template.yaml`](../../infra/aws-frontend-hosting/template.yaml)
and the proposed changeset first. The template creates a private, versioned S3 bucket,
CloudFront OAC, KVS, viewer-request Function, wildcard distribution, and a narrow
policy attached to the supplied existing worker role. It does not create DNS records,
ACM certificates, EC2 instances, or instance profiles.

Set values from the actual account; do not copy fabricated sample IDs:

```bash
read -r -p "AWS region for the S3 bucket: " AWS_REGION
read -r -p "Existing EC2 worker IAM role name: " WORKER_ROLE_NAME
read -r -p "Issued wildcard ACM certificate ARN: " CERTIFICATE_ARN

aws cloudformation validate-template \
  --template-body file://infra/aws-frontend-hosting/template.yaml

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --template-file infra/aws-frontend-hosting/template.yaml \
  --stack-name mavly-frontend-hosting-staging \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ExistingWorkerRoleName="$WORKER_ROLE_NAME" \
    ViewerCertificateArn="$CERTIFICATE_ARN"
```

Use a staging-specific stack name and account. This is an operator procedure; no
CloudFormation operation has been run by this implementation task. Check the stack
outputs and inspect the resulting bucket policy, role policy, distribution, alias,
OAC, and KVS before continuing. CloudFront distribution deployment can take time.

The template's bucket uses S3-managed AES-256 encryption and versioning, blocks public
access, enforces bucket-owner ownership, and allows reads only from the distribution
through OAC. The worker policy allows object reads/writes and KVS updates only for
these resources; it does not grant `DeleteObject`, bucket-wide listing, invalidation,
or access to unrelated S3 resources.

## 4. Set the server-only app and worker configuration

Set these names with matching non-secret values in the Mavly server deployment and
the existing EC2 worker process:

| Variable | Value source |
|---|---|
| `MAVLY_AWS_FRONTEND_HOSTING_ENABLED` | Leave off until staging acceptance |
| `MAVLY_AWS_S3_BUCKET` | `FrontendBucketName` stack output |
| `MAVLY_AWS_REGION` | Actual region where the stack's S3 bucket was created |
| `MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN` | `TenantRouteStoreArn` stack output |
| `MAVLY_AWS_FRONTEND_HOSTING_PROJECTS` | Explicit internal project IDs only |

These are not `NEXT_PUBLIC_*` values. No AWS secret key is used. The publishing API
only creates a database job; the EC2 worker uses its standard instance-profile
credentials to access S3 and KVS. Keep the feature flag off in production until
migration, worker, host routing, and rollback acceptance are complete.

The code uses `us-east-1` for the CloudFront KVS control-plane client. The
`MAVLY_AWS_REGION` value is specifically the S3 bucket region; it is not guessed or
defaulted by the application.

## 5. Apply the database migration through the reviewed release process

Apply `supabase/migrations/51_aws_frontend_deployment.sql` after migrations 14, 15,
and 16. Use the same reviewed migration process as other production schema changes.
Do not apply it from this runbook to a production database. The migration is additive;
it has not been run against a database in this task.

After applying in staging, confirm the `aws_frontend_hosting_schema_version()` RPC
returns `51` for both the authenticated application path and service-role worker
preflight. Verify worker RPC grants and RLS behavior using the repository's existing
manual acceptance procedure.

## 6. Staging publication checks

Before enabling an internal project:

1. Confirm it has no existing Vercel or shared-hosting deployment.
2. Confirm its hostname is routed to the staging CloudFront distribution using a
   controlled test DNS record or a staging hostname arrangement approved by the
   domain operator. Do not switch the wildcard record.
3. Add exactly that internal project ID to the cohort.
4. Enable the flag in staging only, then restart/redeploy the existing worker with the
   same non-secret configuration.
5. Publish a small static project and watch the actual worker logs for queue claim,
   upload, verification, KVS activation, and fenced completion. Logs must not contain
   file content or secrets.
6. Confirm the deployment API reports `ready` only after worker completion and the
   expected hostname serves the right project/version metadata.
7. Test `/`, a SPA route, a real JS/CSS/image asset, a missing JS/CSS/image asset,
   repeated publish, worker restart during upload, queued unpublish, and project
   deletion only after the worker confirms unpublish completion.
8. Confirm direct public S3 object access is denied and the previous active version
   stays mapped after a failed publish.

Useful read-only checks once actual values are available:

```bash
aws cloudformation describe-stacks \
  --stack-name mavly-frontend-hosting-staging \
  --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}' \
  --output table

aws cloudfront get-distribution \
  --id "$DISTRIBUTION_ID" \
  --query 'Distribution.{Status:Status,Aliases:DistributionConfig.Aliases.Items,Domain:DomainName}' \
  --output json

dig +short "$INTERNAL_PROJECT_ID.mavly.xyz"
curl --silent --show-error --head "https://$INTERNAL_PROJECT_ID.mavly.xyz/"
```

The CloudFront check must show `Deployed`; the TLS request must validate the
certificate. Check the actual served content and asset responses in a browser too.
These commands have not been run as part of this task.

## 7. Rollback and recovery

- **A queued or failed upload:** leave the immutable objects in place; the existing
  worker queue retries idempotently and verifies object checksum/metadata before
  reusing them. Do not delete objects manually while a job may still be active.
- **KVS activation or database completion failure:** the worker attempts to restore
  the route to the database's prior active version. If route recovery reports an
  error, keep the feature paused and inspect the deployment row, publication row,
  active version, and KVS value together before any manual change.
- **Unpublish:** use the authorized project deployment API. It queues an unpublish
  job and reports `unpublishing`; it does not mutate KVS from the app server. The
  existing EC2 worker writes a generation-fenced tombstone, confirms the public route
  returns 404, and only then clears the active database pointer. Keep the KVS ARN and
  worker role available while draining unpublish jobs, even if publishing is disabled.
  A failed or unconfirmed removal never reports the project as unpublished.
- **Project deletion:** the API waits for that worker-owned unpublish to complete. If
  removal cannot be confirmed, deletion is refused.
- **Rollback to a prior AWS publication:** not implemented. Do not manually edit KVS
  or deployment rows; an owner-checked rollback API and acceptance tests are still
  required.
- **DNS rollback:** no wildcard cutover is approved. If an operator has separately
  changed DNS, restore the previous provider target only under the domain operator's
  incident procedure.

## 8. Production blockers

The following are required before production rollout:

- Confirmed AWS account, worker region, and existing EC2 instance profile.
- Staging template deployment and policy review.
- Migration 51 applied and checked in staging.
- Successful AWS publication/unpublish/delete acceptance with the real worker.
- CloudFront access logging and alerting.
- Owner-checked rollback to a prior immutable version.
- Resumable migration of existing shared/Vercel publications and dual-read serving.
- A reviewed DNS plan that preserves all existing `*.mavly.xyz` tenants.
- Live Neon/gateway readiness acceptance where a generated app needs a customer
  backend. AWS static hosting does not run generated Next.js server code.

Until these are complete, AWS hosting is **NOT VERIFIED** and production DNS cutover
is **BLOCKED**. See
[`Phase 15 architecture`](../architecture/phase-15-aws-frontend-hosting.md).
