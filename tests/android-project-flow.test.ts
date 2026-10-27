import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const dashboard = read("src/components/builder/BuilderDashboard.tsx");
const workspaceRoute = read("src/app/project/[projectId]/page.tsx");
const androidWorkspace = read("src/components/workspace/AndroidWorkspace.tsx");
const api = read("src/lib/mavly/api.ts");
const store = read("src/lib/mavly/store.ts");
const runAgent = read("src/lib/mavly/run-agent.ts");
const previewRoute = read("src/app/api/preview/[projectId]/[[...path]]/route.ts");
const apiRoute = read("src/app/api/vcaas/[...path]/route.ts");
const typeMigration = read("supabase/migrations/22_project_type.sql");
const idempotencyMigration = read("supabase/migrations/25_project_creation_idempotency.sql");
const projectTransferDialogs = read("src/components/workspace/ProjectTransferDialogs.tsx");
const vcaasClient = read("src/lib/vcaas.ts");

test("Android prompt submissions create a persisted Android project and start native generation without a naming modal", () => {
  const start = dashboard.indexOf('if (promptMode === "android") {', dashboard.indexOf("const submitBuild"));
  const end = dashboard.indexOf("ONE CALL: CREATE THE PROJECT AND START BUILDING", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const androidCreate = dashboard.slice(start, end);

  assert.match(dashboard, /const submitBuild = async \(\) =>/);
  assert.doesNotMatch(dashboard, /nameModalOpen|openBuildModal|Name your project/);
  assert.match(dashboard, /shouldSubmitPrompt\(e\.key, e\.shiftKey\)[\s\S]*?void submitBuild\(\)/);
  assert.match(dashboard, /onClick=\{\(\) => void submitBuild\(\)\}/);
  assert.match(androidCreate, /vcaasApi\.projects\.create\(/);
  assert.match(androidCreate, /projectType:\s*"android"/);
  assert.match(androidCreate, /clientRequestId:\s*requestId/);
  assert.match(androidCreate, /vcaasApi\.agent\.start\(/);
  assert.doesNotMatch(androidCreate, /projects\.launch\(/);
});

test("Website Build continues through the existing launch and generation flow", () => {
  assert.match(dashboard, /vcaasApi\.projects\.launch\(/);
  assert.match(dashboard, /projectType:\s*promptMode/);
  assert.match(api, /runAgent\(\{/);
  assert.match(dashboard, /router\.push\(`\/project\/\$\{created\}`\)/);
  assert.match(dashboard, /setItem\(`vibebuild:pendingPrompt:\$\{created\}`, prompt\)/);
});

test("prompt naming uses the validated slug utility and a safe deterministic fallback", () => {
  assert.match(dashboard, /suggestProjectSlug\(prompt, "my-app"\)/);
  assert.match(dashboard, /validateProjectSlug\(proposedId\) === null \? proposedId : "my-app"/);
  assert.match(dashboard, /PROJECT_SLUG_MAX_LENGTH/);
});

test("failed creation keeps the prompt, shows an actionable error, and blocks duplicate submissions", () => {
  assert.match(dashboard, /if \(buildCreatingRef\.current\) return/);
  assert.match(dashboard, /disabled=\{!firstPrompt\.trim\(\) \|\| buildCreating\}/);
  assert.match(dashboard, /role="alert"[\s\S]*?Your prompt is still here; you can correct it and retry/);
  assert.match(dashboard, /finally \{[\s\S]*?buildCreatingRef\.current = false;\s*setBuildCreating\(false\);/);
});

test("Android project types persist and legacy rows default to website", () => {
  assert.match(typeMigration, /project_type text not null default 'website'/);
  assert.match(typeMigration, /check \(project_type in \('website', 'android'\)\)/);
  assert.match(store, /project_type:\s*targetType/);
  assert.match(store, /normalizeProjectType/);
  assert.match(api, /function projectTypeOf\(value: unknown\)[\s\S]*?value === undefined \|\| value === "website"/);
});

test("Android creation retries return the same owner-scoped project", () => {
  assert.match(idempotencyMigration, /unique index if not exists projects_user_creation_request_id_idx/);
  assert.match(idempotencyMigration, /on public\.projects \(user_id, creation_request_id\)/);
  assert.match(store, /\.eq\("user_id", userId\)[\s\S]*?\.eq\("creation_request_id", creationRequestId\)/);
  assert.match(dashboard, /sessionStorage\.setItem\([\s\S]*?mavly:android-project-create/);
  assert.match(dashboard, /buildCreatingRef\.current/);
});

test("project list and detail responses preserve persisted type for reopening", () => {
  const projectFromRow = api.slice(api.indexOf("function projectFromRow"));
  assert.match(api, /projectType: row\.project_type \?\? "website"/);
  assert.match(api, /project\.data\.project_type === "android"/);
  assert.match(projectFromRow, /projectType: row\.project_type \?\? "website"/);
  assert.match(workspaceRoute, /project\.projectType === "android"/);
  assert.match(workspaceRoute, /project\.projectId !== projectId/);
});

test("dashboard cards identify Android projects and avoid website previews for them", () => {
  assert.ok((dashboard.match(/p\.projectType === "android"/g) ?? []).length >= 4);
  assert.match(dashboard, /<AndroidProjectPlaceholder isRow=\{false\} \/>/);
  assert.match(dashboard, /<AndroidProjectPlaceholder isRow \/>/);
  assert.match(dashboard, /<ProjectPreview project=\{p\} variant="row" \/>/);
});

test("Android workspace generates source, edits files and drives real build controls", () => {
  assert.match(androidWorkspace, /vcaasApi\.files\.tree/);
  assert.match(androidWorkspace, /vcaasApi\.files\.content/);
  assert.match(androidWorkspace, /vcaasApi\.files\.write/);
  assert.match(androidWorkspace, /vcaasApi\.agent\.start\(/);
  assert.match(androidWorkspace, /vcaasApi\.agent\.status\(/);
  assert.match(androidWorkspace, /mavly:android-generation:\$\{project\.projectId\}/);
  assert.match(androidWorkspace, /setGenerationError\(parsed\.error\)/);
  assert.match(androidWorkspace, /vcaasApi\.v2\.mobileBuilds/);
  assert.match(androidWorkspace, /vcaasApi\.v2\.startMobileBuild/);
  assert.match(androidWorkspace, /vcaasApi\.v2\.cancelMobileBuild/);
  assert.match(androidWorkspace, /vcaasApi\.v2\.mobileBuildDownload/);
  assert.match(androidWorkspace, /vcaasApi\.v2\.mobileBuildLog/);
  assert.match(androidWorkspace, /Debug APK/);
  assert.match(androidWorkspace, /Native preview unavailable/);
  assert.match(androidWorkspace, /Emulator unavailable/);
  assert.doesNotMatch(androidWorkspace, /PreviewPanel|fake APK|placeholder APK/);
});

test("Android projects use the native generation profile instead of the website profile", () => {
  assert.doesNotMatch(api, /ANDROID_GENERATION_NOT_CONFIGURED/);
  assert.doesNotMatch(api, /rejectAndroidGeneration\(userId, projectId\)/);
  assert.match(runAgent, /project\.data\.project_type === "android" \? "android" : "website"/);
  assert.match(runAgent, /androidPackageForProject\(input\.projectId\)/);
  assert.match(runAgent, /projectType,\s*\n\s*androidPackage,/);
  assert.match(runAgent, /if \(projectType === "website"\) \{\s*\n\s*await handOffVerification/);
});

test("Android projects do not receive a static website preview or website publish", () => {
  assert.match(previewRoute, /project\.data\.project_type === "android"/);
  assert.match(api, /rejectAndroidWebsiteDeployment\(userId, projectId\)/);
  assert.match(dashboard, /Kotlin\/Compose source/);
});

test("existing project authentication, ownership, and credit paths are not bypassed", () => {
  assert.match(apiRoute, /resolveVcaasContext\(\)/);
  assert.match(apiRoute, /checkProjectAccess\(auth\.team, identity\.projectId\)/);
  assert.match(apiRoute, /checkProjectAccess\(auth\.team, scope\.projectId\)/);
  const start = dashboard.indexOf('if (promptMode === "android") {');
  const end = dashboard.indexOf("ONE CALL: CREATE THE PROJECT AND START BUILDING", start);
  const androidCreate = dashboard.slice(start, end);
  assert.doesNotMatch(androidCreate, /credit|charge|reserve|settle|refund/i);
});

test("failed Android project creation does not navigate to a workspace", () => {
  const start = dashboard.indexOf('if (promptMode === "android") {');
  const end = dashboard.indexOf("ONE CALL: CREATE THE PROJECT AND START BUILDING", start);
  const androidCreate = dashboard.slice(start, end);
  assert.match(androidCreate, /if \(!created\.ok \|\| !created\.data\)[\s\S]*?return;/);
  assert.match(androidCreate, /router\.push\(`\/project\/\$\{encodeURIComponent\(created\.data\.projectId\)\}`\)/);
});

test("dashboard project mode persists, filters by stored type, and governs creation", () => {
  assert.match(dashboard, /localStorage\.getItem\(PROJECT_TYPE_MODE_KEY\)/);
  assert.match(dashboard, /localStorage\.setItem\(PROJECT_TYPE_MODE_KEY, projectType\)/);
  assert.match(dashboard, /vcaasApi\.projects\.list\(\{ projectType \}\)/);
  assert.match(dashboard, /requestId !== projectListRequestRef\.current/);
  assert.match(vcaasClient, /projectType\?: "website" \| "android"/);
  assert.match(vcaasClient, /query\.set\("projectType", params\.projectType\)/);
  assert.match(api, /query\.getAll\("projectType"\)/);
  assert.match(store, /\.eq\("project_type", projectType\)/);
  assert.match(dashboard, /projectType: promptMode/);
  assert.match(dashboard, /No \{promptMode === "website" \? "websites" : "Android apps"\} yet/);
});

test("dashboard imports use the selected type and duplicates preserve their source type", () => {
  assert.doesNotMatch(dashboard, /ImportProjectDialog|importOpen|setImportOpen/);
  assert.doesNotMatch(projectTransferDialogs, /ImportProjectDialog|transfer\.import\./);
  assert.match(dashboard, /<CloneProjectDialog[\s\S]*?projectType=\{projects\.find/);
  assert.match(projectTransferDialogs, /projectType === "android"[\s\S]*?crypto\.randomUUID\(\)/);
  assert.match(projectTransferDialogs, /\.\.\.\(requestId \? \{ clientRequestId: requestId \} : \{\}\)/);
  assert.match(projectTransferDialogs, /await runImport\(\{[\s\S]*?projectType,\s*\}\);/);
});
