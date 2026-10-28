import type { Metadata } from "next";
import Link from "next/link";
import {
  GitBranch,
  Globe,
  Cpu,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Key,
  ExternalLink,
  Layers,
  Sparkles,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  title: "Integrations — Mavly AI Website Builder",
  description:
    "Connect GitHub repositories, publish static sites, and generate website code with OpenRouter.",
  openGraph: {
    title: "Integrations — Mavly AI Website Builder",
    description:
      "Connect GitHub repositories, publish static sites, and generate website code with OpenRouter.",
    images: ["/logo/Mavly.png"],
  },
};

export default function IntegrationsPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-20">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-5 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-stone-600 bg-stone-100 px-3 py-1 rounded-full border border-black/[0.04]">
            <Layers className="w-3.5 h-3.5 text-stone-800" />
            <span>CONNECTED WORKFLOWS</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-gray-950 leading-[1.1]">
            Connect your tools. Keep your workflow moving.
          </h1>

          <p className="text-base sm:text-lg text-gray-600 leading-relaxed font-normal max-w-2xl mx-auto">
            Explore how Mavly connects website projects with the tools you use to build, manage, and publish them.
          </p>

          <div className="pt-2">
            <Link
              href="/docs"
              className="mavly-btn-secondary px-5 py-2.5 text-xs font-semibold inline-flex items-center gap-2"
            >
              <span>Read Integration Guides</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>

        {/* Core Integrations Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* GitHub App */}
          <div className="p-8 rounded-3xl bg-white border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-6">
            <div className="flex items-center justify-between">
              <div className="w-12 h-12 rounded-2xl bg-gray-950 text-white flex items-center justify-center">
                <GitBranch className="w-6 h-6" />
              </div>
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                Verified Available
              </span>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-950">GitHub App</h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Connect your personal GitHub account through the official GitHub App flow to push code, link repositories, and track revisions.
              </p>
            </div>

            <div className="space-y-2.5 text-xs text-gray-700 border-t border-black/[0.06] pt-4">
              <h4 className="font-semibold text-gray-900">Supported Capabilities:</h4>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Connect account via secure user-to-server OAuth token exchange.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Select any accessible personal or organization repository.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Create new repository when GitHub App permissions and authorization allow.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Empty repository initialization: first push creates branch and initial commit.</span>
                </li>
              </ul>
            </div>

            <div className="p-3.5 rounded-xl bg-gray-50 border border-black/[0.04] text-[11px] text-gray-500">
              <strong>Security Invariant:</strong> Tokens are encrypted using AES-256-GCM and never exposed to client browsers or model prompts.
            </div>
          </div>

          {/* Vercel Publishing */}
          <div className="p-8 rounded-3xl bg-white border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-6">
            <div className="flex items-center justify-between">
              <div className="w-12 h-12 rounded-2xl bg-black text-white flex items-center justify-center font-bold">
                ▲
              </div>
              <span className="text-[11px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full">
                Operator Configured
              </span>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-950">Vercel Publishing</h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Mavly-managed static publishing uploads generated standalone static preview assets to custom subdomains.
              </p>
            </div>

            <div className="space-y-2.5 text-xs text-gray-700 border-t border-black/[0.06] pt-4">
              <h4 className="font-semibold text-gray-900">Publishing Prerequisites:</h4>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                  <span>Attaches server-derived <code>&lt;project-id&gt;.mavly.xyz</code> domain upon build completion.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                  <span>Requires operator token activation and verified DNS wildcard resolution.</span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-gray-500">
                    Fails closed with <code>BACKEND_NOT_CONFIGURED</code> if the operator has not enabled Vercel deployments.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          {/* OpenRouter code generation */}
          <div className="p-8 rounded-3xl bg-white border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-6">
            <div className="flex items-center justify-between">
              <div className="w-12 h-12 rounded-2xl bg-purple-600 text-white flex items-center justify-center">
                <Cpu className="w-6 h-6" />
              </div>
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                Website/code provider
              </span>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-950">OpenRouter Code Generation</h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Website and code-generation requests use OpenRouter from the server-side Next.js runtime.
              </p>
            </div>

            <div className="space-y-2.5 text-xs text-gray-700 border-t border-black/[0.06] pt-4">
              <h4 className="font-semibold text-gray-900">Configured Model:</h4>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>DeepSeek V4.1 Flash:</strong> OpenRouter default model for website creation and follow-up code edits.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Generation fails explicitly if OpenRouter is unavailable; no provider fallback is configured.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Zero client-side API keys exposed: all generation executed server-side.</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Integration Setup Checklist */}
        <div className="p-8 sm:p-12 rounded-3xl bg-white border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-6">
          <div className="max-w-2xl">
            <h3 className="text-xl font-bold text-gray-950">Quick Integration Checklist</h3>
            <p className="text-xs sm:text-sm text-gray-600 mt-1">
              Follow these simple steps inside your project workspace to connect your services:
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-xs text-gray-700">
            <div className="p-4 rounded-xl bg-gray-50 border border-black/[0.04] space-y-2">
              <span className="font-bold text-gray-950">1. Authorize Service</span>
              <p className="text-gray-600 leading-relaxed">
                Open the workspace settings or integrations panel and authorize the GitHub App through its secure OAuth flow.
              </p>
            </div>
            <div className="p-4 rounded-xl bg-gray-50 border border-black/[0.04] space-y-2">
              <span className="font-bold text-gray-950">2. Select Project / Repo</span>
              <p className="text-gray-600 leading-relaxed">
                Choose the exact repository and branch where project files should synchronize or initialize an empty repo.
              </p>
            </div>
            <div className="p-4 rounded-xl bg-gray-50 border border-black/[0.04] space-y-2">
              <span className="font-bold text-gray-950">3. Review and Push</span>
              <p className="text-gray-600 leading-relaxed">
                Verify generated changes in the diff viewer and trigger an automated commit push anytime.
              </p>
            </div>
          </div>

          <div className="pt-2">
            <Link
              href="/docs"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-black hover:underline"
            >
              <span>Explore full integration documentation</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}
