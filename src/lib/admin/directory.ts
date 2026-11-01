export interface AdminUserDirectoryRow {
  id: string;
  name: string;
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
  name: string;
  ownerId: string;
  owner: string;
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
