"use client";

import React, { useState } from "react";
import {
  Settings,
  Shield,
  Bell,
  Cpu,
  Globe,
  DollarSign,
  User,
  Key,
  Save,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  Lock,
  Layers,
  Terminal,
  Radio,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";

export default function SettingsAdminPage() {
  // General & Brand
  const [platformName, setPlatformName] = useState("Mavly AI App Builder");
  const [adminConsoleTitle, setAdminConsoleTitle] = useState("Mavly Admin Control Center");
  const [supportEmail, setSupportEmail] = useState("support@mavly.xyz");

  // AI Defaults
  const [defaultModel, setDefaultModel] = useState("deepseek/deepseek-v4.1-flash");
  const [fallbackModel, setFallbackModel] = useState("anthropic/claude-3.5-sonnet");
  const [maxTokens, setMaxTokens] = useState("8192");
  const [temperature, setTemperature] = useState("0.2");

  // Regional & Currency
  const [currency, setCurrency] = useState("INR");
  const [gateway, setGateway] = useState("Razorpay");
  const [invoicePrefix, setInvoicePrefix] = useState("INV-MAV-");

  // Security Toggles
  const [require2FA, setRequire2FA] = useState(true);
  const [sessionTimeout, setSessionTimeout] = useState("30");
  const [highFidelityAudit, setHighFidelityAudit] = useState(true);

  // Notifications
  const [emailAlertsOnFailure, setEmailAlertsOnFailure] = useState(true);
  const [dailyRevenueDigest, setDailyRevenueDigest] = useState(true);
  const [slackWebhook, setSlackWebhook] = useState("https://hooks.slack.com/services/T00/B00/XXXXXX");

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    toast.success("Preferences updated successfully!", {
      description: "Frontend configuration saved locally for this administrative session.",
    });
  };

  const handleResetDefaults = () => {
    setPlatformName("Mavly AI App Builder");
    setAdminConsoleTitle("Mavly Admin Control Center");
    setSupportEmail("support@mavly.xyz");
    setDefaultModel("deepseek/deepseek-v4.1-flash");
    setFallbackModel("anthropic/claude-3.5-sonnet");
    setMaxTokens("8192");
    setTemperature("0.2");
    setCurrency("INR");
    setGateway("Razorpay");
    setInvoicePrefix("INV-MAV-");
    setRequire2FA(true);
    setSessionTimeout("30");
    setHighFidelityAudit(true);
    setEmailAlertsOnFailure(true);
    setDailyRevenueDigest(true);

    toast.info("Settings restored to system baseline parameters.");
  };

  return (
    <AdminShell activeNav="Settings">
      <form onSubmit={handleSaveSettings} className="space-y-4">
        {/* Top Header with Save Action */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              System Configuration & Environmental Variables
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Customize AI orchestration, regional currency, compliance rules, and operational dispatch
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] rounded-lg transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>

            <button
              type="submit"
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-primary hover:bg-[var(--neu-brand-hover)] rounded-lg transition-colors shadow-xs"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save Changes</span>
            </button>
          </div>
        </div>

        {/* 1. General Branding & Profile */}
        <div className="p-5 sm:p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-[var(--neu-line)]">
            <Globe className="w-4 h-4 text-foreground" />
            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
              Organization & Application Profile
            </h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block font-semibold text-foreground mb-1">
                Platform Name
              </label>
              <input
                type="text"
                value={platformName}
                onChange={(e) => setPlatformName(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg shadow-[var(--neu-inset-1)] outline-none focus-visible:shadow-[var(--neu-inset-1),var(--neu-focus)] text-foreground"
              />
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Admin Console Header
              </label>
              <input
                type="text"
                value={adminConsoleTitle}
                onChange={(e) => setAdminConsoleTitle(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg shadow-[var(--neu-inset-1)] outline-none focus-visible:shadow-[var(--neu-inset-1),var(--neu-focus)] text-foreground"
              />
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Support Routing Email
              </label>
              <input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg shadow-[var(--neu-inset-1)] outline-none focus-visible:shadow-[var(--neu-inset-1),var(--neu-focus)] text-foreground"
              />
            </div>
          </div>
        </div>

        {/* 2. AI Model & Generation Defaults */}
        <div className="p-5 sm:p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-[var(--neu-line)]">
            <Cpu className="w-4 h-4 text-purple-600" />
            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
              AI Orchestration & Generation Parameters
            </h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-semibold text-foreground mb-1">
                Default Primary Gateway Model
              </label>
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="w-full h-8 px-2.5 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-medium text-foreground"
              >
                <option value="deepseek/deepseek-v4.1-flash">
                  DeepSeek V4.1 Flash (Fast, Built-in Default)
                </option>
                <option value="anthropic/claude-3.5-sonnet">
                  Anthropic Claude 3.5 Sonnet (High Accuracy)
                </option>
                <option value="google/gemini-2.0-flash">
                  Google Gemini 2.0 Flash (Fast Reasoning)
                </option>
                <option value="openai/gpt-4o">OpenAI GPT-4o</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Automatic Circuit Failover Model
              </label>
              <select
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                className="w-full h-8 px-2.5 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-medium text-foreground"
              >
                <option value="anthropic/claude-3.5-sonnet">
                  Anthropic Claude 3.5 Sonnet
                </option>
                <option value="deepseek/deepseek-v4.1-flash">
                  DeepSeek V4.1 Flash
                </option>
                <option value="google/gemini-1.5-pro">Google Gemini 1.5 Pro</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Max Output Tokens Per Run
              </label>
              <input
                type="text"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-mono text-foreground"
              />
              <span className="text-[11px] text-muted-foreground mt-1 block">
                Standard output cap for generated Next.js AST files
              </span>
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Sampling Temperature
              </label>
              <input
                type="text"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-mono text-foreground"
              />
              <span className="text-[11px] text-muted-foreground mt-1 block">
                0.2 ensures code determinism and syntax stability
              </span>
            </div>
          </div>
        </div>

        {/* 3. Regional Billing & Payment Processing */}
        <div className="p-5 sm:p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-[var(--neu-line)]">
            <DollarSign className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
              Regional Billing & Payment Gateway
            </h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block font-semibold text-foreground mb-1">
                Primary Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full h-8 px-2.5 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-medium text-foreground"
              >
                <option value="INR">INR (₹) Indian Rupee</option>
                <option value="USD">USD ($) United States Dollar</option>
                <option value="EUR">EUR (€) Euro</option>
                <option value="GBP">GBP (£) British Pound</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Active Payment Gateway
              </label>
              <select
                value={gateway}
                onChange={(e) => setGateway(e.target.value)}
                className="w-full h-8 px-2.5 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-medium text-foreground"
              >
                <option value="Razorpay">Razorpay (Cards, UPI, NetBanking)</option>
                <option value="Stripe">Stripe (International Credit Cards)</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Invoice ID Prefix
              </label>
              <input
                type="text"
                value={invoicePrefix}
                onChange={(e) => setInvoicePrefix(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-mono text-foreground"
              />
            </div>
          </div>
        </div>

        {/* 4. Security & Audit Policies */}
        <div className="p-5 sm:p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-[var(--neu-line)]">
            <Shield className="w-4 h-4 text-blue-600" />
            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
              Admin Security Governance & Access Control
            </h4>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--neu-sunken)]/80 border border-[var(--neu-line)]">
              <div>
                <p className="font-semibold text-foreground">Enforce Multi-Factor Authentication</p>
                <p className="text-muted-foreground text-[11px]">
                  Require hardware security key or TOTP token on administrative logins
                </p>
              </div>
              <input
                type="checkbox"
                checked={require2FA}
                onChange={(e) => setRequire2FA(e.target.checked)}
                className="rounded border-[var(--neu-line-strong)] text-black focus:ring-black h-4 w-4"
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--neu-sunken)]/80 border border-[var(--neu-line)]">
              <div>
                <p className="font-semibold text-foreground">High-Fidelity Event Journaling</p>
                <p className="text-muted-foreground text-[11px]">
                  Capture complete JSON mutation payloads for security and compliance audits
                </p>
              </div>
              <input
                type="checkbox"
                checked={highFidelityAudit}
                onChange={(e) => setHighFidelityAudit(e.target.checked)}
                className="rounded border-[var(--neu-line-strong)] text-black focus:ring-black h-4 w-4"
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--neu-sunken)]/80 border border-[var(--neu-line)]">
              <div>
                <p className="font-semibold text-foreground">Session Inactivity Timeout</p>
                <p className="text-muted-foreground text-[11px]">
                  Automatically invalidate idle administrative credentials
                </p>
              </div>
              <select
                value={sessionTimeout}
                onChange={(e) => setSessionTimeout(e.target.value)}
                className="h-8 px-2.5 text-xs bg-card border border-[var(--neu-line)] rounded-lg"
              >
                <option value="15">15 Minutes</option>
                <option value="30">30 Minutes</option>
                <option value="60">1 Hour</option>
                <option value="120">2 Hours</option>
              </select>
            </div>
          </div>
        </div>

        {/* 5. Notification Webhooks & Alerts */}
        <div className="p-5 sm:p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-[var(--neu-line)]">
            <Bell className="w-4 h-4 text-amber-600" />
            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
              Alerts & Operational Dispatch
            </h4>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--neu-sunken)]/80 border border-[var(--neu-line)]">
              <div>
                <p className="font-semibold text-foreground">Critical Error & Spike Alerts</p>
                <p className="text-muted-foreground text-[11px]">
                  Send emergency email alert if AI failure rate exceeds 2.5%
                </p>
              </div>
              <input
                type="checkbox"
                checked={emailAlertsOnFailure}
                onChange={(e) => setEmailAlertsOnFailure(e.target.checked)}
                className="rounded border-[var(--neu-line-strong)] text-black focus:ring-black h-4 w-4"
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--neu-sunken)]/80 border border-[var(--neu-line)]">
              <div>
                <p className="font-semibold text-foreground">Daily MRR & Revenue Digest</p>
                <p className="text-muted-foreground text-[11px]">
                  Send summary recap every morning at 09:00 IST
                </p>
              </div>
              <input
                type="checkbox"
                checked={dailyRevenueDigest}
                onChange={(e) => setDailyRevenueDigest(e.target.checked)}
                className="rounded border-[var(--neu-line-strong)] text-black focus:ring-black h-4 w-4"
              />
            </div>

            <div>
              <label className="block font-semibold text-foreground mb-1">
                Slack Incident Webhook URL
              </label>
              <input
                type="text"
                value={slackWebhook}
                onChange={(e) => setSlackWebhook(e.target.value)}
                className="w-full h-8 px-3 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg focus:outline-none focus:bg-card font-mono text-[11px] text-foreground"
              />
            </div>
          </div>
        </div>

        {/* 6. Admin Account Information */}
        <div className="p-5 sm:p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center font-bold text-xs shrink-0">
              SA
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold text-foreground">Mavly Super Admin</h4>
                <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200/60">
                  Organization Owner
                </span>
              </div>
              <p className="text-xs text-muted-foreground font-mono">aitoolkitguide@gmail.com</p>
            </div>
          </div>

          <div className="text-xs text-muted-foreground sm:text-right font-mono text-[11px]">
            <p>Signed in via Visual Admin Prototype</p>
            <p>Session IP: 103.21.244.12</p>
          </div>
        </div>
      </form>
    </AdminShell>
  );
}
