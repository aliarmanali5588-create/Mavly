/**
 * ═══ THE SECURITY AGENT — DETERMINISTIC STATIC REVIEW ═══════════════════════
 *
 * This role makes NO model call. It scans the resulting source with bounded,
 * deterministic rules, so it cannot be talked out of a finding by a prompt and
 * it does not invent one. It reports paths and line numbers, never the matched
 * secret value.
 *
 * ⚠️ A CLEAN SCAN IS NOT A SECURITY PROOF. It is one static check over generated
 * text. Authorization, runtime behaviour, dependency vulnerabilities and the
 * provider sandbox are outside it, and the result says so.
 *
 * ⚠️ GENERATED CODE IS DATA. A finding never executes anything; it only blocks
 * the workflow from reporting a clean verification and from proposing a deploy.
 */

import type { AgentFinding, AgentVerificationResult, ProjectFile } from "./contracts";

interface Rule {
  id: string;
  severity: AgentFinding["severity"];
  title: string;
  /** A bounded, redacted explanation. Never includes the matched value. */
  detail: string;
  pattern: RegExp;
  /** Restrict the rule to certain path shapes. */
  appliesTo?: (path: string) => boolean;
}

const CLIENT_FILE = /^(app|src|components|pages|lib)\/.*\.(tsx?|jsx?)$/i;
const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|kt|java|gradle|xml|html|json|md)$/i;

function looksLikeClientFile(content: string): boolean {
  return /^\s*["']use client["'];?/m.test(content.slice(0, 400));
}

function isAndroidPath(path: string): boolean {
  return /(^|\/)(AndroidManifest\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/.test(path);
}

const RULES: readonly Rule[] = [
  {
    id: "private-key",
    severity: "critical",
    title: "Private key material in generated source",
    detail: "A PEM private-key header was found. Generated projects must never contain key material.",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    appliesTo: (path) => SOURCE_FILE.test(path),
  },
  {
    id: "provider-secret-literal",
    severity: "critical",
    title: "Provider secret literal in generated source",
    detail: "A value shaped like a live provider secret was found. The value is not recorded here.",
    pattern: /(?:sk-or-v1-|sk-proj-|rzp_live_|AKIA[0-9A-Z]{16})[A-Za-z0-9_\-]{8,}/,
    appliesTo: (path) => SOURCE_FILE.test(path),
  },
  {
    id: "service-role-in-client",
    severity: "critical",
    title: "Service-role key reachable from client code",
    detail:
      "A client module references a server-only secret. A generated app must keep privileged keys in server code.",
    pattern: /SUPABASE_SERVICE_ROLE_KEY/,
    appliesTo: () => true,
  },
  {
    id: "env-secret-in-client",
    severity: "high",
    title: "Non-public environment variable used in client code",
    detail:
      "A client module reads a non-NEXT_PUBLIC_ environment variable. Next.js will not expose it, so the behaviour is either broken or an attempt to leak a secret.",
    pattern: /process\.env\.(?!NEXT_PUBLIC_|NODE_ENV)[A-Z][A-Z0-9_]{2,}/,
    appliesTo: (path) => CLIENT_FILE.test(path),
  },
  {
    id: "hardcoded-credential",
    severity: "high",
    title: "Hard-coded credential-shaped assignment",
    detail:
      "A literal assignment to a credential-shaped name was found. Use an environment variable or a placeholder such as YOUR_KEY_HERE.",
    pattern:
      /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
    appliesTo: (path) => SOURCE_FILE.test(path) && !/\.env\.example$/i.test(path),
  },
  {
    id: "child-process",
    severity: "medium",
    title: "Process execution in generated code",
    detail:
      "The source imports child_process or calls a sync exec/spawn helper. Mavly never runs this code, but a generated server route that shells out is risky.",
    pattern: /(?:require\(["']child_process["']\)|from\s+["'](?:node:)?child_process["']|execSync\s*\(|spawnSync\s*\()/,
    appliesTo: (path) => SOURCE_FILE.test(path),
  },
  {
    id: "dynamic-code",
    severity: "medium",
    title: "Dynamic code evaluation",
    detail:
      "The source uses eval/new Function/vm. Generated code is data, and dynamic evaluation makes review and sandboxing harder.",
    pattern: /(?:\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn(?:New|This)?Context\s*\()/,
    appliesTo: (path) => SOURCE_FILE.test(path),
  },
  {
    id: "unsafe-html",
    severity: "low",
    title: "Raw HTML injection",
    detail:
      "dangerouslySetInnerHTML is present. If the value is user-controlled, escape or sanitize it.",
    pattern: /dangerouslySetInnerHTML/,
    appliesTo: (path) => SOURCE_FILE.test(path),
  },
  {
    id: "android-debuggable",
    severity: "critical",
    title: "Debuggable Android manifest",
    detail: "The generated manifest enables android:debuggable. This is not allowed in generated source.",
    pattern: /android:debuggable\s*=\s*["']true["']/,
    appliesTo: (path) => isAndroidPath(path),
  },
  {
    id: "android-cleartext",
    severity: "high",
    title: "Cleartext network traffic enabled",
    detail: "The generated manifest enables usesCleartextTraffic. Generated apps must use HTTPS.",
    pattern: /android:usesCleartextTraffic\s*=\s*["']true["']/,
    appliesTo: (path) => isAndroidPath(path),
  },
  {
    id: "android-release-signing",
    severity: "critical",
    title: "Release signing material in generated Gradle",
    detail:
      "A signingConfig/storePassword/keyAlias block was found. Release signing is not implemented and must never be generated.",
    pattern: /(?:signingConfigs|storePassword|keyPassword|keyAlias)\b/,
    appliesTo: (path) => isAndroidPath(path),
  },
];

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index && position < content.length; position += 1) {
    if (content.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

const MAX_SCAN_BYTES = 1_500_000;
const MAX_SCAN_FILES = 120;

/**
 * Scan the merged source. Findings are deduplicated per (rule, path, line) and
 * bounded, so a pathological file cannot make the result unbounded.
 */
export function securityReview(files: readonly ProjectFile[]): {
  verification: AgentVerificationResult;
  findings: AgentFinding[];
} {
  const findings: AgentFinding[] = [];
  const seen = new Set<string>();
  const evidence: string[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let skipped = 0;

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (scannedFiles >= MAX_SCAN_FILES) {
      skipped += 1;
      continue;
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (scannedBytes + bytes > MAX_SCAN_BYTES) {
      skipped += 1;
      continue;
    }
    scannedFiles += 1;
    scannedBytes += bytes;

    for (const rule of RULES) {
      if (rule.appliesTo && !rule.appliesTo(file.path)) continue;
      if (rule.id === "service-role-in-client" && !looksLikeClientFile(file.content)) {
        continue;
      }
      const match = rule.pattern.exec(file.content);
      if (!match || match.index === undefined) continue;
      const line = lineOf(file.content, match.index);
      const key = `${rule.id}:${file.path}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: rule.id,
        severity: rule.severity,
        title: rule.title,
        detail: rule.detail,
        path: file.path,
        line,
      });
      if (findings.length >= 40) break;
    }
    if (findings.length >= 40) break;
  }

  if (skipped > 0) {
    evidence.push(`${skipped} file(s) were not scanned because the bounded scan budget was reached.`);
  }

  const critical = findings.filter((finding) => finding.severity === "critical");
  const high = findings.filter((finding) => finding.severity === "high");
  const status: AgentVerificationResult["status"] =
    critical.length > 0 ? "failed" : "passed";

  const checks = [
    {
      id: "secrets",
      label: "No live credential material",
      status: critical.some((finding) => finding.id.includes("secret") || finding.id === "private-key")
        ? ("failed" as const)
        : ("passed" as const),
      detail: "Deterministic pattern scan over generated text; not a secret scanner for every provider.",
    },
    {
      id: "privileged-access",
      label: "No server-only key in client code",
      status: findings.some((finding) => finding.id === "service-role-in-client")
        ? ("failed" as const)
        : ("passed" as const),
      detail: "Checks client modules for server-only Supabase/service-role references.",
    },
    {
      id: "unsafe-execution",
      label: "No obvious dynamic execution",
      status: findings.some(
        (finding) => finding.id === "child-process" || finding.id === "dynamic-code",
      )
        ? ("failed" as const)
        : ("passed" as const),
      detail: "Static pattern check only; the generated code is never executed by Mavly.",
    },
    {
      id: "android-manifest",
      label: "Android manifest hardening",
      status: findings.some((finding) => finding.id.startsWith("android-"))
        ? ("failed" as const)
        : ("passed" as const),
      detail: "Debug, cleartext and release-signing markers are refused.",
    },
    {
      id: "authorization",
      label: "Authorization and tenant isolation",
      status: "unavailable" as const,
      detail:
        "Static scanning cannot prove authorization. Ownership and RLS are enforced by Mavly's server routes, not by generated code.",
    },
  ];

  const summary =
    critical.length > 0
      ? `Security review failed: ${critical.length} critical finding(s).`
      : high.length > 0
        ? `Security review passed with ${high.length} high-severity warning(s).`
        : findings.length > 0
          ? `Security review passed with ${findings.length} non-blocking finding(s).`
          : "Security review found no matches in the bounded static scan.";

  return {
    findings,
    verification: {
      status,
      summary,
      checks,
      evidence: [
        `Scanned ${scannedFiles} text file(s), ${scannedBytes} byte(s).`,
        ...evidence,
        "Static review is not a runtime, authorization or dependency-vulnerability proof.",
      ],
    },
  };
}
