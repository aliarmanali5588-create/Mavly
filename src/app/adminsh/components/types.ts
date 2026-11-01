export type AdminNavSection =
  | "Overview"
  | "Users"
  | "Billing & Revenue"
  | "AI Usage & Cost"
  | "Generation Monitor"
  | "Projects"
  | "Credits"
  | "Announcements"
  | "System Health"
  | "Audit Logs"
  | "Settings";

export interface KpiItem {
  id: string;
  title: string;
  value: string;
  change: string;
  isPositive: boolean;
  timeframe: string;
  icon: string;
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  plan: "Free" | "Starter" | "Creator" | "Pro" | "Agency";
  projectsCount: number;
  creditsRemaining: number;
  joinedDate: string;
  status: "Active" | "Inactive" | "Suspended";
  role?: string;
  lastActive?: string;
}

export interface GenerationRecord {
  id: string;
  project: string;
  owner: string;
  model: string;
  status: "Completed" | "Running" | "Failed" | "Queued";
  duration: string;
  createdAt: string;
  promptSnippet?: string;
  tokensUsed?: string;
  errorLog?: string;
}

export interface CreditTransactionRecord {
  id: string;
  user: string;
  email: string;
  type: "Grant" | "Usage" | "Purchase" | "Refund" | "Adjustment";
  amount: number;
  balanceAfter: number;
  timestamp: string;
  reason: string;
}

export interface AnnouncementRecord {
  id: string;
  title: string;
  content: string;
  type: "Information" | "Success" | "Warning" | "Maintenance";
  status: "Published" | "Scheduled" | "Draft" | "Expired";
  targetPlan: string;
  startDate: string;
  expiryDate: string;
  dismissible: boolean;
  linkUrl?: string;
}

export interface SystemServiceStatus {
  name: string;
  status: "Operational" | "Degraded" | "Maintenance";
  uptime: string;
  latency: string;
  description: string;
}

export interface IncidentRecord {
  id: string;
  title: string;
  service: string;
  status: "Resolved" | "Investigating" | "Monitoring";
  timestamp: string;
  duration: string;
  impact: string;
  details: string;
}

export interface AuditLogRecord {
  id: string;
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  status: "Success" | "Failed";
  source: string;
  ip: string;
  payloadJson?: string;
}
