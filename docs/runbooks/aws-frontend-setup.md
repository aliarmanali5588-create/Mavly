# AWS frontend hosting setup and operations

## Status and stop conditions

This runbook prepares an operator to stage the AWS publisher. It does not certify a
production deployment. Repository changes do not create, modify, or delete AWS
resources or database state. The operator-provided resources below are recorded as
partially verified until the read-only reconciliation commands and the end-to-end
staging acceptance are run by an authorized operator.

## Resource reconciliation snapshot

The following values are the operator-provided production resource candidates in
account `505384438340`, region `eu-north-1`:

| Resource | Current classification | Safe staging decision |
|---|---|---|
| EC2 `i-05ac7a8d4a0e1d499` / `mavly-generation-worker` | Existing; instance-profile assumption was verified by the operator | Reuse the existing instance and `MavlyEC2SSMRole`; never create a second worker |
| S3 `mavly-frontend-505384438340-eu-north-1-an` | Existing; `HeadBucket` was verified, but privacy, ownership, encryption, versioning, bucket policy, and actual object writes were not fully verified here | Treat as a production candidate; do not use for staging |
| CloudFront KVS `mavly-tenant-routing-prod` / `5ea7516a-8088-4833-9749-4aac8b6f652c` | Existing; `DescribeKeyValueStore` was verified and last reported `READY` with zero items; `GetKey`/`UpdateKeys` were not fully verified by a live operation | Treat as a production candidate; do not use for staging |
| IAM policy `MavlyAWSFrontendHostingPublisher` | Existing and attached to `MavlyEC2SSMRole`; policy simulation allowed the configured actions | Review resource scopes and actual `GetObject`/`PutObject`/KVS operations before production use; do not overwrite it |
| CloudFront distribution, OAC, viewer Function, cache policy, wildcard certificate, DNS | Not supplied as verified existing resources | Create only in the dedicated staging stack or reconcile through a separately approved production change |

The staging template defaults to a new CloudFormation-managed bucket and KVS. Its
stack-scoped worker policy is limited to those staging resources and grants only
`s3:GetObject`, `s3:PutObject`, and the three KVS control-plane actions used by the
publisher. It grants no `s3:DeleteObject`, bucket listing, IAM administration,
CloudFront distribution administration, or unrelated-resource access.

**Do not change `*.mavly.xyz` DNS to CloudFront.** The current Function serves only
projects with AWS KVS entries. It has no fallback to existing shared-hosting or
Vercel sites, and no resumable migration utility has been implemented. A wildcard
cutover would make unmapped projects return 404. First implement and accept dual-read
compatibility and migrate every existing tenant.

Do not use this feature to replace an existing Vercel or shared deployment. The
application refuses that transition until a migration path exists.

## 1. Confirm prerequisites in the target AWS account

Use the real account and region already designated for the generation worker. Do not
choose a region based on an example in this repository. The expected values for this
environment are account `505384438340` and `eu-north-1`; the commands below must still
be run by the operator.

```bash
aws sts get-caller-identity
aws configure list
```

Identify the existing EC2 instance, instance profile, and role using the supplied
instance identifier:

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

Reconcile the supplied production candidates without printing credentials:

```bash
aws sts get-caller-identity
aws s3api head-bucket --bucket mavly-frontend-505384438340-eu-north-1-an
aws s3api get-public-access-block \
  --bucket mavly-frontend-505384438340-eu-north-1-an
aws s3api get-bucket-ownership-controls \
  --bucket mavly-frontend-505384438340-eu-north-1-an
aws s3api get-bucket-encryption \
  --bucket mavly-frontend-505384438340-eu-north-1-an
aws s3api get-bucket-versioning \
  --bucket mavly-frontend-505384438340-eu-north-1-an
aws s3api get-bucket-policy \
  --bucket mavly-frontend-505384438340-eu-north-1-an \
  --query Policy --output text
aws cloudfront-keyvaluestore describe-key-value-store \
  --kvs-arn arn:aws:cloudfront::505384438340:key-value-store/5ea7516a-8088-4833-9749-4aac8b6f652c \
  --region us-east-1
aws iam get-role --role-name MavlyEC2SSMRole \
  --query 'Role.{RoleName:RoleName,Arn:Arn}' --output table
aws iam list-role-policies --role-name MavlyEC2SSMRole --output table
aws iam list-attached-role-policies --role-name MavlyEC2SSMRole --output table
```

If any existing bucket policy contains an unreviewed statement, do not apply the
CloudFormation bucket-policy resource to that bucket. The production reuse mode sets
`ManageFrontendBucketPolicy=false` and requires a separately reviewed policy change.

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
and a proposed changeset first. In its staging mode, the template creates a private,
versioned S3 bucket, CloudFront OAC, KVS, viewer-request Function, cache policy,
single-tenant CloudFront distribution, bucket policy, and a narrow policy attached to
the supplied existing worker role. It does not create DNS records, ACM certificates,
EC2 instances, or instance profiles. It never targets the supplied production bucket
or KVS unless the operator explicitly selects the existing-resource parameters.

Set values from the actual account; do not copy fabricated sample IDs:

```bash
read -r -p "AWS region for the S3 bucket [eu-north-1]: " AWS_REGION
read -r -p "Existing EC2 worker IAM role name [MavlyEC2SSMRole]: " WORKER_ROLE_NAME
read -r -p "Dedicated staging project ID: " TEST_PROJECT_ID
read -r -p "Issued wildcard ACM certificate ARN: " CERTIFICATE_ARN

aws cloudformation validate-template \
  --template-body file://infra/aws-frontend-hosting/template.yaml

aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name mavly-frontend-hosting-staging \
  --change-set-name initial-staging-review \
  --change-set-type CREATE \
  --template-body file://infra/aws-frontend-hosting/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameters \
    ParameterKey=DeploymentStage,ParameterValue=staging \
    ParameterKey=ViewerCertificateArn,ParameterValue="$CERTIFICATE_ARN" \
    ParameterKey=ViewerAlias,ParameterValue="$TEST_PROJECT_ID.mavly.xyz" \
    ParameterKey=ExistingWorkerRoleName,ParameterValue="$WORKER_ROLE_NAME" \
    ParameterKey=CreateFrontendBucket,ParameterValue=true \
    ParameterKey=CreateTenantRouteStore,ParameterValue=true \
    ParameterKey=ManageFrontendBucketPolicy,ParameterValue=true \
    ParameterKey=AttachWorkerHostingPolicy,ParameterValue=true

aws cloudformation describe-change-set \
  --region "$AWS_REGION" \
  --stack-name mavly-frontend-hosting-staging \
  --change-set-name initial-staging-review \
  --query 'Changes[*].ResourceChange.{Action:Action,LogicalId:LogicalResourceId,Type:ResourceType,Replacement:Replacement}' \
  --output table

# Execute only after the change set has been reviewed and approved.
aws cloudformation execute-change-set \
  --region "$AWS_REGION" \
  --stack-name mavly-frontend-hosting-staging \
  --change-set-name initial-staging-review
```

Use a staging-specific stack name and account. This is an operator procedure; no
CloudFormation operation has been run by this implementation task. Check the stack
outputs and inspect the resulting bucket policy, role policy, distribution, alias,
OAC, and KVS before continuing. CloudFront distribution deployment can take time.

The staging bucket uses S3-managed AES-256 encryption and versioning, blocks public
access, enforces bucket-owner ownership, and allows reads only from the staging
distribution through OAC. The worker policy allows object reads/writes and KVS updates
only for these resources; it does not grant `DeleteObject`, bucket-wide listing,
invalidation, or access to unrelated S3 resources. Review the change set before
execution and record its outputs. No stack deployment is performed by this repository
task.

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

Inspect presence without printing values or credentials:

```bash
for name in \
  MAVLY_AWS_FRONTEND_HOSTING_ENABLED \
  MAVLY_AWS_S3_BUCKET \
  MAVLY_AWS_REGION \
  MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN \
  MAVLY_AWS_FRONTEND_HOSTING_PROJECTS; do
  if grep -q "^${name}=" /etc/mavly/worker.env; then
    echo "$name present"
  else
    echo "$name missing"
  fi
done
grep '^MAVLY_AWS_FRONTEND_HOSTING_ENABLED=' /etc/mavly/worker.env \
  | sed -E 's/=.*/=<redacted; inspect the flag through the approved config review>/'
```

The application deployment and `/etc/mavly/worker.env` must use the same bucket,
region, KVS ARN, and one-project staging cohort. Production remains explicitly
`MAVLY_AWS_FRONTEND_HOSTING_ENABLED=false`.

## 5. Apply the database migration through the reviewed release process

Apply `supabase/migrations/51_aws_frontend_deployment.sql` after migrations 14, 15,
and 16. Use the same reviewed migration process as other production schema changes.
Do not apply it from this runbook to a production database. The migration is additive;
it has not been run against a database in this task.

After applying in staging, run these safe verification queries through the reviewed
database procedure. Do not run them against production without explicit approval:

```sql
select public.shared_hosting_schema_version();
select public.generation_worker_schema_version();
select public.aws_frontend_hosting_schema_version();

select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name like '%aws_frontend%'
order by routine_name;

select relname, relrowsecurity
from pg_class
where relname in ('aws_frontend_publications', 'aws_frontend_unpublish_jobs');
```

Expected markers are 15, 16, and 51. The worker refuses to claim AWS work below 51.
Verify worker RPC grants and RLS behavior using the repository's reviewed database
procedure. A missing marker or RPC is a staging blocker; do not fabricate a ready
publication.

## 6. Staging publication checks

Before enabling an internal project:

Use a disposable project with no existing production deployment and perform this
checklist in order:

1. Confirm the project has no existing Vercel or shared-hosting deployment.
2. Confirm the exact project hostname is routed to the staging CloudFront distribution
   by an approved DNS record; do not switch `*.mavly.xyz`.
3. Confirm the certificate covers the exact hostname and CloudFront reports `Deployed`.
4. Add exactly that project ID to the staging cohort; do not use `*`.
5. Enable the flag in staging only, then review the existing worker environment.
6. Keep `mavly-aws-generation-worker.service` as the only worker service.
7. If approved, restart that service once after the reviewed configuration/repository
   deployment; do not restart it earlier.
8. Confirm the worker log reports its existing entrypoint and no second worker loop.
9. Queue a small static publication through the authorized Mavly API.
10. Confirm the publication claim includes a lease and routing generation.
11. Confirm S3 receives only `<project>/<version>/<relative-path>` objects.
12. Confirm each object has the expected SHA-256, size, content type, project metadata,
    and version metadata.
13. Confirm a repeated publication reuses matching immutable objects.
14. Confirm KVS activation succeeds with an ETag-aware update.
15. Confirm the public route serves the correct HTML at `/`.
16. Confirm a client-routed extensionless SPA path serves the entry document.
17. Confirm JavaScript, CSS, and image assets are served with their expected content.
18. Confirm a missing asset returns 404 and an encoded traversal attempt is rejected.
19. Confirm the deployment is recorded `ready` only after route verification and fenced
    database completion.
20. Start a second publication and force a safe staging failure (for example, a
    reviewed temporary permission denial), then confirm the previous active version
    remains mapped and the attempt is retryable/error as appropriate.
21. Stop/restart the existing worker during a disposable upload and confirm lease
    recovery does not duplicate or activate a stale attempt.
22. Queue an authorized unpublish and confirm the worker writes a generation-fenced
    disabled KVS mapping first.
23. Confirm the public hostname returns 404 before the database row becomes
    `unpublished`.
24. Confirm direct anonymous S3 object access is denied while CloudFront access works.
25. Confirm project deletion is refused until unpublish completion, then succeeds only
    after the worker-confirmed unpublished state.

The staging acceptance is not complete until the operator records the actual status,
hashes, HTTP responses, and sanitized worker events for this disposable project.

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

The existing service remains:

```text
mavly-aws-worker.service
User=mavly-worker
WorkingDirectory=/srv/mavly
EnvironmentFile=/etc/mavly/worker.env
ExecStart=/usr/bin/node --import /srv/mavly/workers/register-node-ts-resolver.mjs /srv/mavly/workers/aws-generation-worker.ts
```

Only after the reviewed change and configuration are ready, an authorized operator
may use:

```bash
sudo systemctl restart mavly-aws-worker.service
sudo systemctl status mavly-aws-worker.service --no-pager
sudo journalctl -u mavly-aws-worker.service --since "10 minutes ago" --no-pager
```

The restart reuses the existing process and queue; it does not create a publication
daemon or a second generation worker.

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
