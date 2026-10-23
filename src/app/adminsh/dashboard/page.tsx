"use client";

import React from "react";
import { AdminShell } from "../components/AdminShell";
import { KpiCards } from "../components/KpiCards";
import { RevenueChart } from "../components/RevenueChart";
import { AiUsageSection } from "../components/AiUsageSection";
import { GenerationsTable } from "../components/GenerationsTable";
import { TransactionsTable } from "../components/TransactionsTable";
import { PlatformHealth } from "../components/PlatformHealth";
import { QuickActionsModal } from "../components/QuickActionsModal";

export default function AdminDashboardPage() {
  return (
    <AdminShell activeNav="Overview">
      {/* 1. KPI Summary Cards */}
      <KpiCards />

      {/* 2. Analytics Section Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RevenueChart />
        <AiUsageSection />
      </div>

      {/* 3. Quick Actions Bar */}
      <QuickActionsModal onSelectNav={() => {}} />

      {/* 4. Recent Activity & Transactions Grid */}
      <div className="space-y-6">
        <GenerationsTable />
        <TransactionsTable />
      </div>

      {/* 5. Infrastructure Platform Health */}
      <PlatformHealth />
    </AdminShell>
  );
}
