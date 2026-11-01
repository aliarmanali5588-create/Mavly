export interface AdminUserDirectoryRow {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  role: string | null;
  plan: null;
  projectCount: number;
  availableCredits: string | null;
  status: "Not Banned" | "Banned";
  bannedUntil: string | null;
}

export interface AdminUserDirectoryMetrics {
  total: number;
  createdThisMonth: number;
  createdLast7Days: number;
  banned: number;
}

export interface AdminUserDirectoryResponse {
  rows: AdminUserDirectoryRow[];
  total: number;
  page: number;
  pageSize: number;
  metrics: AdminUserDirectoryMetrics;
  planFilterAvailable: false;
  statusFilterAvailable: true;
  generatedAt: string;
}

export type AdminProjectGenerationStatus =
  | "all"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "no_run";

export type AdminProjectVisibility =
  | "custom_domain"
  | "preview_url"
  | "draft";

export interface AdminProjectDirectoryRow {
  id: string;
  name: string | null;
  ownerId: string;
  owner: string | null;
  ownerEmail: string | null;
  createdAt: string;
  updatedAt: string;
  generationStatus: Exclude<AdminProjectGenerationStatus, "all">;
  generationStage: string | null;
  model: string | null;
  deploymentStatus: "published" | "deploying" | "failed" | "unpublished" | "draft";
  deploymentAttemptStatus: string | null;
  visibility: AdminProjectVisibility;
  publishedUrl: string | null;
  routesCount: null;
}

export interface AdminProjectDirectoryMetrics {
  total: number;
  createdThisMonth: number;
  createdLast7Days: number;
  published: number;
  verifiedMavlyDomains: number;
}

export interface AdminProjectDirectoryResponse {
  rows: AdminProjectDirectoryRow[];
  total: number;
  page: number;
  pageSize: number;
  status: AdminProjectGenerationStatus;
  visibility: "all" | AdminProjectVisibility;
  metrics: AdminProjectDirectoryMetrics;
  generatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const PROJECT_STATUSES = new Set([
  "queued", "running", "completed", "failed", "cancelled", "interrupted", "no_run",
]);
const PROJECT_VISIBILITIES = new Set(["custom_domain", "preview_url", "draft"]);
const PROJECT_DEPLOYMENT_STATUSES = new Set([
  "published", "deploying", "failed", "unpublished", "draft",
]);

export function isAdminUserDirectoryResponse(
  value: unknown
): value is AdminUserDirectoryResponse {
  if (!isRecord(value) || !Array.isArray(value.rows) || !isRecord(value.metrics)) return false;
  return (
    isCount(value.total)
    && isCount(value.page)
    && value.page > 0
    && isCount(value.pageSize)
    && value.pageSize > 0
    && isCount(value.metrics.total)
    && isCount(value.metrics.createdThisMonth)
    && isCount(value.metrics.createdLast7Days)
    && isCount(value.metrics.banned)
    && value.planFilterAvailable === false
    && value.statusFilterAvailable === true
    && typeof value.generatedAt === "string"
    && value.rows.every((row: unknown) =>
      isRecord(row)
      && typeof row.id === "string"
      && isNullableString(row.name)
      && isNullableString(row.email)
      && typeof row.createdAt === "string"
      && isNullableString(row.lastSignInAt)
      && isNullableString(row.role)
      && row.plan === null
      && isCount(row.projectCount)
      && isNullableString(row.availableCredits)
      && (row.status === "Not Banned" || row.status === "Banned")
      && isNullableString(row.bannedUntil)
    )
  );
}

export function isAdminProjectDirectoryResponse(
  value: unknown
): value is AdminProjectDirectoryResponse {
  if (!isRecord(value) || !Array.isArray(value.rows) || !isRecord(value.metrics)) return false;
  return (
    isCount(value.total)
    && isCount(value.page)
    && value.page > 0
    && isCount(value.pageSize)
    && value.pageSize > 0
    && (value.status === "all" || (typeof value.status === "string" && PROJECT_STATUSES.has(value.status)))
    && (value.visibility === "all" || (typeof value.visibility === "string" && PROJECT_VISIBILITIES.has(value.visibility)))
    && isCount(value.metrics.total)
    && isCount(value.metrics.createdThisMonth)
    && isCount(value.metrics.createdLast7Days)
    && isCount(value.metrics.published)
    && isCount(value.metrics.verifiedMavlyDomains)
    && typeof value.generatedAt === "string"
    && value.rows.every((row: unknown) =>
      isRecord(row)
      && typeof row.id === "string"
      && isNullableString(row.name)
      && typeof row.ownerId === "string"
      && isNullableString(row.owner)
      && isNullableString(row.ownerEmail)
      && typeof row.createdAt === "string"
      && typeof row.updatedAt === "string"
      && typeof row.generationStatus === "string"
      && PROJECT_STATUSES.has(row.generationStatus)
      && isNullableString(row.generationStage)
      && isNullableString(row.model)
      && typeof row.deploymentStatus === "string"
      && PROJECT_DEPLOYMENT_STATUSES.has(row.deploymentStatus)
      && isNullableString(row.deploymentAttemptStatus)
      && typeof row.visibility === "string"
      && PROJECT_VISIBILITIES.has(row.visibility)
      && isNullableString(row.publishedUrl)
      && row.routesCount === null
    )
  );
}
