"use client";

import React from "react";

import { ADMIN_PERIODS, type AdminPeriod } from "@/lib/admin/overview";
import { AdminShell } from "../components/AdminShell";
import { KpiCards } from "../components/KpiCards";
import { RevenueChart } from "../components/RevenueChart";
import { AiUsageSection } from "../components/AiUsageSection";
import { GenerationsTable } from "../components/GenerationsTable";
import { TransactionsTable } from "../components/TransactionsTable";
import { PlatformHealth } from "../components/PlatformHealth";
import { QuickActionsModal } from "../components/QuickActionsModal";
import { useAdminOverview } from "../components/useAdminLiveData";

export default function AdminDashboardPage() {
  const [period, setPeriod] = React.useState<AdminPeriod>("30d");
  const { data, loading, error, refresh } = useAdminOverview(period);

  const periodLabel =
    ADMIN_PERIODS.find((entry) => entry.id === period)?.description.toLowerCase() ?? "last 30 days";

  // The header indicator is derived from measured/configured checks only. It never
  // displays a historical uptime percentage, because none is recorded.
  const operationalCount = data?.health.filter((check) => check.state === "operational").length ?? 0;
  const statusTone: "ok" | "warn" | "unknown" = error
    ? "unknown"
    : !data
      ? "unknown"
      : data.health.some((check) => check.state === "degraded" || check.state === "down")
        ? "warn"
        : operationalCount === data.health.length
          ? "ok"
          : "unknown";

  const statusSummary = error
    ? "Status unavailable"
    : !data
      ? "Checking services…"
      : statusTone === "warn"
        ? `${data.health.filter((check) => check.state === "degraded" || check.state === "down").length} service(s) need attention`
        : `${operationalCount} of ${data.health.length} checks operational`;

  return (
    <AdminShell
      activeNav="Overview"
      live
      period={period}
      onPeriodChange={setPeriod}
      statusSummary={statusSummary}
      statusTone={statusTone}
      environment={data?.environment}
      version={data?.version}
      userCount={data?.users.total ?? null}
    >
      {/* 1. KPI Summary Cards */}
      <KpiCards
        data={data}
        loading={loading}
        error={error}
        onRetry={refresh}
        periodLabel={periodLabel}
      />

      {/* 2. Analytics Section Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RevenueChart live data={data} error={Boolean(error)} />
        <AiUsageSection live data={data} error={Boolean(error)} />
      </div>

      {/* 3. Quick Actions Bar */}
      <QuickActionsModal data={data} error={Boolean(error)} />

      {/* 4. Recent Activity & Transactions Grid */}
      <div className="space-y-6">
        <GenerationsTable />
        <TransactionsTable />
      </div>

      {/* 5. Infrastructure Platform Health */}
      <PlatformHealth live data={data} error={Boolean(error)} />
    </AdminShell>
  );
}
