"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { vcaasApi } from "@/lib/vcaas";
import {
  CloneProjectDialog,
  ExportProjectDialog,
  ImportProjectDialog,
} from "@/components/workspace/ProjectTransferDialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FigmaModal } from "@/components/workspace/FigmaModal";
import { FigmaPromptButton } from "@/components/prompt/FigmaPromptButton";
import { GithubModal } from "@/components/workspace/GithubModal";
import { GithubPromptButton } from "@/components/prompt/GithubPromptButton";
import { AuthNav } from "@/components/auth/AuthNav";
import { AnimatedPlaceholder } from "@/components/builder/AnimatedPlaceholder";
import { shouldAnimatePlaceholder, shouldSubmitPrompt } from "@/lib/animated-placeholder";
import { PROJECT_SLUG_MAX_LENGTH, suggestProjectSlug, validateProjectSlug } from "@/lib/project-slug";
import { AttachmentPreviews } from "@/components/workspace/AttachmentPreview";
import { filesFromClipboard } from "@/lib/attachments";
import { t } from "@/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Loader2, Trash2, Send, Paperclip, X, ArrowRight, Copy, Upload, Download,
  Search, LayoutGrid, Table as TableIcon, ArrowUpDown, ChevronLeft, ChevronRight,
  AlertCircle, MoreVertical, AlertTriangle, Monitor, Globe, Smartphone,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { uploadFilesToProjectDetailed, splitBySize, MAX_UPLOAD_MB, TOO_LARGE_ADVICE } from "@/lib/upload";
import type { VcaasProjectSummary } from "@/lib/vcaas-types";
import type { ProfileSummary } from "@/lib/user-profile";

type ViewMode = "cards" | "table";
type SortKey = "date-desc" | "date-asc" | "name-asc" | "name-desc";

const PAGE_SIZE = 20;
const VIEW_MODE_KEY = "vibebuild:dashboard-view";

// --- The project tile: the real preview, or an honest placeholder -------------
const PREVIEW_BASE_WIDTH = 1280;
const PREVIEW_BASE_HEIGHT = 800;

type PreviewStatus = "idle" | "checking" | "available" | "missing" | "error";

/**
 * Session-lifetime availability cache.
 *
 * Mavly does not generate screenshots and the list response carries no thumbnail
 * field, so a card asks the existing sandboxed preview route whether it has a
 * `preview.html` at all. The answer is remembered for the tab, so paging back and
 * changing sort/search does not repeat the check. Network failures are not cached,
 * so a transient error can recover on the next visit.
 */
const previewAvailability = new Map<string, "available" | "missing">();

/**
 * A real label when one exists, otherwise the slug made readable.
 *
 * The local store writes a slug into `label` when the user did not type a separate
 * name, so a label that still looks like a slug is formatted rather than shown raw:
 * `my-app` → `My App`. Anything with spaces or capitals is treated as a real name
 * and left exactly as the user wrote it. The stored id and route never change.
 */
function displayProjectName(project: { projectId: string; label?: string | null }): string {
  const raw = project.label?.trim() || project.projectId;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) return raw;
  const words = raw.replace(/[-_]+/g, " ").trim();
  if (!words) return raw;
  return words.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** Last change when the store has it, else creation. */
function projectTimestamp(project: { createdAt: string; lastModifiedAt?: string }): number {
  const value = Date.parse(project.lastModifiedAt || project.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function formatProjectDate(project: { createdAt: string; lastModifiedAt?: string }): string {
  const value = Date.parse(project.lastModifiedAt || project.createdAt);
  if (!Number.isFinite(value)) return "";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function PreviewPlaceholder({ name, text, isRow }: { name: string; text: string; isRow: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-[#f7f6f3] px-3 text-center">
      <div className={`rounded-lg border border-black/[0.06] bg-white flex items-center justify-center shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${isRow ? "w-5 h-5" : "w-8 h-8"}`}>
        <Monitor className={`text-gray-300 ${isRow ? "w-3 h-3" : "w-4 h-4"}`} />
      </div>
      <span className={`font-medium text-gray-600 line-clamp-2 leading-snug ${isRow ? "text-[8px]" : "text-[11px]"}`} title={name}>
        {name}
      </span>
      <span className={`uppercase tracking-[0.12em] text-gray-400 ${isRow ? "hidden" : "text-[8px]"}`}>{text}</span>
    </div>
  );
}

function AndroidProjectPlaceholder({ isRow }: { isRow: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-[#f7f6f3] px-3 text-center">
      <div className={`rounded-lg border border-black/[0.06] bg-white flex items-center justify-center shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${isRow ? "w-5 h-5" : "w-8 h-8"}`}>
        <Smartphone className={`text-gray-400 ${isRow ? "w-3 h-3" : "w-4 h-4"}`} aria-hidden="true" />
      </div>
      <span className={`font-medium text-gray-600 ${isRow ? "text-[8px]" : "text-[11px]"}`}>Android app</span>
      <span className={`text-gray-400 ${isRow ? "hidden" : "text-[8px]"}`}>Kotlin/Compose source</span>
    </div>
  );
}

/**
 * ═══⭐⭐⭐ THE PROJECT TILE — THE ACTUAL PREVIEW, LAZILY ═════════════════════
 *
 * The local builder's only visual artifact is the generated `preview.html`, served
 * same-origin by `/api/preview/{id}/` behind the normal session and ownership checks.
 * There is no stored screenshot and no screenshot service in this repository, so the
 * tile embeds that static preview directly rather than inventing an image URL.
 *
 * ⚠️ NOTHING LOADS UNTIL THE CARD IS NEAR THE VIEWPORT. An IntersectionObserver mounts
 * the frame only then, and a HEAD request first asks whether `preview.html` exists.
 * A project that has never finished a build never mounts a frame at all and shows the
 * neutral placeholder below.
 *
 * ⚠️ THE FRAME IS DECORATION, NOT A MINI APP. It is inert (`pointer-events-none`),
 * skipped by the keyboard and hidden from assistive tech, so the card remains one
 * link. The preview route's CSP sandbox keeps the document in an opaque origin: it
 * cannot read Mavly's cookies or call the API as the signed-in user.
 *
 * ⚠️ THE PREVIEW RENDERS AT 1280×800 AND IS SCALED, so a desktop layout stays desktop
 * in a 300px card instead of reflowing into a cramped mobile view. Scaling is measured
 * from the card, so the 16:10 crop stays exact at every breakpoint.
 */
function ProjectPreview({
  project,
  variant = "card",
}: {
  project: { projectId: string; label?: string | null };
  variant?: "card" | "row";
}) {
  const { projectId } = project;
  const name = displayProjectName(project);
  const isRow = variant === "row";
  const hostRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [scale, setScale] = useState(0.25);
  const [frameLoaded, setFrameLoaded] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const width = host.clientWidth;
      if (width > 0) setScale(width / PREVIEW_BASE_WIDTH);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    const cached = previewAvailability.get(projectId);
    if (cached) {
      setStatus(cached);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setStatus("checking");
    fetch(`/api/preview/${encodeURIComponent(projectId)}/`, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        const next = response.ok ? "available" : "missing";
        previewAvailability.set(projectId, next);
        if (!cancelled) setStatus(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId, shouldLoad]);

  const hasPreview = status === "available";
  const unavailable = status === "missing" || status === "error";
  const statusText = unavailable
    ? status === "missing"
      ? "Preview not available yet"
      : "Preview unavailable"
    : "Loading preview";

  return (
    <div
      ref={hostRef}
      className="w-full h-full relative overflow-hidden bg-[#f7f6f3]"
      aria-busy={!hasPreview && !unavailable}
    >
      {hasPreview && (
        <iframe
          src={`/api/preview/${encodeURIComponent(projectId)}/`}
          title={`Preview of ${name}`}
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={() => setFrameLoaded(true)}
          className="absolute top-0 left-0 border-0 bg-white pointer-events-none"
          style={{
            width: PREVIEW_BASE_WIDTH,
            height: PREVIEW_BASE_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      )}
      {(!hasPreview || !frameLoaded) && (
        <PreviewPlaceholder
          name={name}
          text={hasPreview ? "Loading preview" : statusText}
          isRow={isRow}
        />
      )}
    </div>
  );
}

export default function DashboardPage({ profile }: { profile: ProfileSummary }) {
  const router = useRouter();
  const [projects, setProjects] = useState<VcaasProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // First-prompt "Build" flow
  const [firstPrompt, setFirstPrompt] = useState("");
  const [promptMode, setPromptMode] = useState<"website" | "android">("website");
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; imageDescription: string; file: File }[]>([]);
  const [uploading, setUploading] = useState(false);
  const heroTextareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * ⭐ THE BOX IS FOCUSED — the animated placeholder gives way to the browser's
   * own hint, so there is never a second caret in the field.
   */
  const [heroFocused, setHeroFocused] = useState(false);

  /**
   * ⭐ THE DRAFT SURVIVES A SIGN-IN REDIRECT.
   *
   * `/dashboard` is behind the session gate, so a visitor who is signed out
   * lands on `/login?redirect=%2Fdashboard` instead of the builder. A prompt
   * that was half-written before that must not be lost, so it is kept in
   * `sessionStorage` (the same place the pending prompt is stashed on the way
   * to the workspace) and put back when the builder comes up again.
   */
  const DRAFT_PROMPT_KEY = "vibebuild:draftPrompt";
  const draftRestored = useRef(false);
  const hadDraft = useRef(false);

  useEffect(() => {
    if (draftRestored.current) return;
    draftRestored.current = true;
    try {
      const draft = window.sessionStorage.getItem(DRAFT_PROMPT_KEY);
      if (draft) setFirstPrompt((current) => (current ? current : draft));
    } catch {
      /* private mode, storage disabled — the draft is a convenience, not a feature */
    }
  }, []);

  useEffect(() => {
    try {
      if (firstPrompt.trim()) {
        hadDraft.current = true;
        window.sessionStorage.setItem(DRAFT_PROMPT_KEY, firstPrompt);
      } else if (hadDraft.current) {
        // The user cleared the box on purpose — do not bring it back later.
        hadDraft.current = false;
        window.sessionStorage.removeItem(DRAFT_PROMPT_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [firstPrompt]);

  /** The animation only runs while the box is empty and nobody is typing in it. */
  const heroAnimated = promptMode === "website" && shouldAnimatePlaceholder(firstPrompt, heroFocused);

  /**
   * ═══⭐ "NEW PROJECT" FOCUSES THE BOX — IT DOES NOT OPEN A FORM ═══════════════
   *
   * The hero composer is the create form: the prompt supplies both the first task
   * and a validated project slug, so there is no separate naming step.
   */
  const focusComposer = useCallback(() => {
    const el = heroTextareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
  }, []);

  /**
   * ═══⭐ FIGMA BEFORE THE PROJECT EXISTS — "PENDING MODE" ═══════════════════════
   *
   * The Figma button sits in the hero's tool tray, exactly as in totalum-platform, but
   * there is no project to store a token on yet. So `FigmaModal` (with no `projectId`)
   * only asks Figma whether the token is good and hands it back; it is held HERE, in
   * memory, and connected the moment the project exists — before the first prompt runs,
   * because a design link in that prompt would otherwise be read by an agent that cannot
   * reach Figma.
   *
   * ⚠️ A LIVE CREDENTIAL IN COMPONENT STATE. Used once, then dropped: never a store, never
   * a cookie, never a log. "Forgetting" it is the only disconnect there can be at this
   * point, and that is what the popover's disconnect does.
   */
  const [figmaToken, setFigmaToken] = useState<string | null>(null);
  const [figmaModalOpen, setFigmaModalOpen] = useState(false);

  /**
   * ═══⭐ GITHUB IMPORT BEFORE A PROJECT EXISTS ═══════════════════════════════
   *
   * `GithubModal` connects a repository to a project, so the dashboard needs a
   * project first. A small name step creates one through the same `projects.create`
   * API the Build flow uses, then hands it to the existing modal. The modal still
   * owns authorization, repository selection, the import plan, recovery points and
   * every safety check.
   *
   * ⚠️ THE PROJECT OUTLIVES A CANCELLED MODAL. It is a real, empty project, not a
   * fake id; closing the dialog before importing leaves it available in the list.
   */
  const [githubProjectId, setGithubProjectId] = useState<string | null>(null);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [githubNameModalOpen, setGithubNameModalOpen] = useState(false);
  const [githubName, setGithubName] = useState("github-import");
  const [githubNameError, setGithubNameError] = useState<string | null>(null);
  const [githubNameCreating, setGithubNameCreating] = useState(false);

  /** A Figma link from the popover lands in the box, appended to whatever is there. */
  const appendToPrompt = useCallback((text: string) => {
    setFirstPrompt((current) => {
      const separator = current.length === 0 || /\s$/.test(current) ? "" : " ";
      return current + separator + text;
    });
    requestAnimationFrame(() => {
      const el = heroTextareaRef.current;
      if (el) { el.focus(); const len = el.value.length; el.setSelectionRange(len, len); }
    });
  }, []);

  // First-prompt project creation
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildCreating, setBuildCreating] = useState(false);
  const buildCreatingRef = useRef(false);
  const androidCreateRequestRef = useRef<{ fingerprint: string; requestId: string } | null>(null);

  // Delete confirmation modal
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // List controls
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date-desc");
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);
  const [page, setPage] = useState(1);

  /*
    ⚠️ THE PER-TILE `GET /projects/{id}` CACHE THAT LIVED HERE IS STILL GONE. The tile
    does not fetch project detail to decide what to draw. It asks the existing
    `/api/preview/{id}/` route (a HEAD, only once the card is near the viewport) whether
    the generated `preview.html` exists, then embeds that already-authorised preview.
    The list request stays the only source of names, descriptions and timestamps.
  */

  /**
   * ═══⭐⭐ MOVING A PROJECT AROUND — EXPORT · IMPORT · DUPLICATE ════════════
   *
   * The three dialogs are totalum-platform's, copied whole, and so is the model behind
   * them (`src/lib/project-transfer.ts`):
   *
   *  · EXPORT packages the database and a source reference into a secret `importCode`.
   *    The code never expires — but it dies with its source project, because what it
   *    points at is that project's files.
   *  · IMPORT restores a code INTO a project, and is DESTRUCTIVE: whatever is in the
   *    target is dropped first, and upstream refuses a target that is not nearly empty.
   *    So the dialog creates a fresh project and imports into that.
   *  · DUPLICATE is those two behind one button — export, create, import — which is why
   *    it shows three steps and costs the sum of both.
   *
   * ⚠️ THEY COST CREDITS AND ARE RATE-LIMITED (1 per minute, 5 per hour, per account).
   * A retry loop without a backoff turns one failure into an hour of them.
   */
  const [exportTarget, setExportTarget] = useState<string | null>(null);
  const [cloneTarget, setCloneTarget] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** The availability check the dialogs run before creating: names already in use here. */
  const takenNames = useMemo(
    () => new Set(projects.map((p) => p.projectId)),
    [projects]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await vcaasApi.projects.list();
      if (res.ok && res.data) {
        const list = Array.isArray(res.data) ? res.data : [];
        list.sort((a, b) => projectTimestamp(b) - projectTimestamp(a));
        setProjects(list);
      }
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Load persisted view mode once on mount.
  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(VIEW_MODE_KEY) : null;
    if (stored === "cards" || stored === "table") setViewMode(stored);
  }, []);

  // If the user hasn't chosen a view yet, default to table when there are many
  // projects (>20), otherwise cards.
  useEffect(() => {
    if (loading || viewMode !== null) return;
    const stored = typeof window !== "undefined" ? localStorage.getItem(VIEW_MODE_KEY) : null;
    if (stored === "cards" || stored === "table") { setViewMode(stored); return; }
    setViewMode(projects.length > 20 ? "table" : "cards");
  }, [loading, viewMode, projects.length]);

  const chooseView = (mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
  };

  // Reset to first page whenever filters/sort change.
  useEffect(() => { setPage(1); }, [search, sortKey, viewMode]);

  // --- Derived: filtered → sorted → paginated ---
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = projects;
    if (q) list = projects.filter((p) =>
      p.projectId.toLowerCase().includes(q) ||
      displayProjectName(p).toLowerCase().includes(q) ||
      (p.description || "").toLowerCase().includes(q)
    );
    const sorted = [...list].sort((a, b) => {
      switch (sortKey) {
        case "date-asc": return projectTimestamp(a) - projectTimestamp(b);
        case "name-asc": return displayProjectName(a).localeCompare(displayProjectName(b));
        case "name-desc": return displayProjectName(b).localeCompare(displayProjectName(a));
        case "date-desc":
        default: return projectTimestamp(b) - projectTimestamp(a);
      }
    });
    return sorted;
  }, [projects, search, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  const resolvedView: ViewMode = viewMode ?? (projects.length > 20 ? "table" : "cards");

  // --- Create helpers ---
  const normalizeId = (raw: string) =>
    raw.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]/, "a").slice(0, PROJECT_SLUG_MAX_LENGTH);

  const suggestName = (prompt: string) => {
    const words = prompt.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean).slice(0, 4).join("-");
    const base = words.length >= 3 ? words : `app-${words}`;
    return normalizeId(base) || "my-app";
  };

  /**
   * ⭐ GITHUB FROM THE HERO COMPOSER. Once a project has been created for this
   * attempt, reopening goes straight to the existing modal.
   */
  const openGithubImport = () => {
    if (githubProjectId) {
      setGithubModalOpen(true);
      return;
    }
    setGithubName(firstPrompt.trim() ? suggestName(firstPrompt) : "github-import");
    setGithubNameError(null);
    setGithubNameModalOpen(true);
  };

  const confirmGithubProject = async () => {
    const id = normalizeId(githubName);
    if (id.length < 3) {
      setGithubNameError("Project name must be at least 3 characters (lowercase, hyphens allowed).");
      return;
    }
    setGithubNameCreating(true);
    setGithubNameError(null);

    const created = await vcaasApi.projects.create({
      projectId: id,
      description: "Imported from GitHub",
      projectType: "website",
      engineVersion: "v2",
    });
    if (!created.ok || !created.data) {
      setGithubNameError(created.error || `Could not create "${id}".`);
      setGithubNameCreating(false);
      return;
    }

    const actualId = created.data.projectId;
    if (actualId !== id) {
      toast.info(`"${id}" was taken — your project is "${actualId}".`);
    }
    setGithubProjectId(actualId);
    setGithubNameModalOpen(false);
    setGithubNameCreating(false);
    setGithubModalOpen(true);
  };

  /**
   * The prompt is on its way to the project — the draft has done its job.
   */
  const clearDraftPrompt = useCallback(() => {
    try {
      window.sessionStorage.removeItem(DRAFT_PROMPT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const submitBuild = async () => {
    if (buildCreatingRef.current) return;
    const prompt = firstPrompt.trim();
    if (!prompt) {
      setBuildError("Describe what you want to build before submitting.");
      return;
    }

    const proposedId = suggestProjectSlug(prompt, "my-app");
    const id = validateProjectSlug(proposedId) === null ? proposedId : "my-app";
    buildCreatingRef.current = true;
    setBuildCreating(true);
    setBuildError(null);
    let navigating = false;

    try {
      if (promptMode === "android") {
        const description = prompt.slice(0, 2_000);
        const fingerprint = `${id}\n${description}`;
        let requestId =
          androidCreateRequestRef.current?.fingerprint === fingerprint
            ? androidCreateRequestRef.current.requestId
            : null;

        if (!requestId) {
          try {
            const stored = window.sessionStorage.getItem("mavly:android-project-create");
            if (stored) {
              const parsed: unknown = JSON.parse(stored);
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                "fingerprint" in parsed &&
                "requestId" in parsed &&
                parsed.fingerprint === fingerprint &&
                typeof parsed.requestId === "string" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.requestId)
              ) {
                requestId = parsed.requestId;
              }
            }
          } catch {
            // Session storage is optional; the in-memory lock still prevents double clicks.
          }
        }

        requestId ??= crypto.randomUUID();
        androidCreateRequestRef.current = { fingerprint, requestId };
        try {
          window.sessionStorage.setItem(
            "mavly:android-project-create",
            JSON.stringify({ fingerprint, requestId }),
          );
        } catch {
          // The server-side request id remains valid even when session storage is unavailable.
        }

        let created: Awaited<ReturnType<typeof vcaasApi.projects.create>>;
        try {
          created = await vcaasApi.projects.create({
            projectId: id,
            description,
            projectType: "android",
            clientRequestId: requestId,
            engineVersion: "v2",
          });
        } catch (error) {
          setBuildError(error instanceof Error ? error.message : "Could not create the Android project.");
          return;
        }

        if (!created.ok || !created.data) {
          setBuildError(created.error || `Could not create "${id}".`);
          return;
        }

        const projectId = created.data.projectId;
        let generationError: string | null = null;
        try {
          const started = await vcaasApi.agent.start(projectId, {
            prompt,
            inputFiles: [],
          });
          if (!started.ok) generationError = started.error || "Could not start Android source generation.";
        } catch (error) {
          generationError = error instanceof Error ? error.message : "Could not start Android source generation.";
        }

        if (generationError) {
          try {
            window.sessionStorage.setItem(
              `mavly:android-generation:${projectId}`,
              JSON.stringify({ prompt, error: generationError }),
            );
          } catch {
            toast.error(generationError, { description: "The project was saved. You can retry generation in its Android workspace." });
          }
        } else {
          try {
            window.sessionStorage.removeItem("mavly:android-project-create");
          } catch {
            // The next request fingerprint prevents this key from being reused for another project.
          }
          androidCreateRequestRef.current = null;
        }

        if (attachedFiles.length > 0) {
          toast.warning("Local attachments were not transferred to the Android project.");
        }
        clearDraftPrompt();
        router.push(`/project/${encodeURIComponent(projectId)}`);
        navigating = true;
        return;
      }

    /**
     * ═══⭐⭐⭐ ONE CALL: CREATE THE PROJECT AND START BUILDING ═════════════════
     *
     * `POST /projects/launch` does what this flow used to do in three steps — create,
     * navigate, auto-submit the prompt from `sessionStorage` — and closes the window in
     * which a project existed with nothing happening inside it.
     *
     * ⚠️ A TAKEN NAME IS NO LONGER AN ERROR. Upstream resolves it (`my-app` → `my-app-x7`)
     * and tells us which id it actually used, so the old "this name is probably already
     * taken, choose another" dead end is gone. We navigate to `data.projectId`, never to
     * the slug we asked for.
     *
     * ⚠️ ATTACHMENTS STILL TAKE THE LONG ROAD, and they have to: `launch` accepts files by
     * URL, and a `blob:` URL from this browser means nothing to the agent. Uploading needs
     * a project to exist, so with attachments we create first, upload, and let the
     * workspace send the prompt — the path this flow always used.
     */
    if (attachedFiles.length === 0) {
      /**
       * ⭐ FIGMA RIDES ALONG. `launch` connects the account BEFORE the first prompt runs,
       * which is the whole point of holding the token until now. A failed connect does
       * not fail the launch — it comes back as a `figma` warning, surfaced below.
       */
      const launched = await vcaasApi.projects.launch({
        engineVersion: "v2", // always the v2 workspace engine
        projectId: id,
        prompt,
        description: prompt.slice(0, 200),
        projectType: promptMode,
        ...(figmaToken ? { figma: { token: figmaToken } } : {}),
      });
      // Used once, then gone — see the note on the state.
      setFigmaToken(null);

      if (!launched.ok || !launched.data) {
        setBuildError(launched.error || `Could not create "${id}". Please try a different name.`);
        return;
      }

      const created = launched.data.projectId;
      if (launched.data.requestedProjectId && launched.data.requestedProjectId !== created) {
        toast.info(`"${launched.data.requestedProjectId}" was taken — your project is "${created}".`);
      }
      /**
       * ⚠️ THE PROJECT CAN EXIST WITHOUT THE RUN HAVING STARTED — that is what
       * `agent.started === false` and the `warnings` array are for. Stashing the prompt
       * then lets the workspace send it on arrival, so the user still ends up where they
       * expected instead of in an empty project with no explanation.
       */
      if (!launched.data.agent?.started) {
        launched.data.warnings?.forEach(w => {
          const message = w?.errorMessage || w?.message;
          if (w?.step !== "figma" && message) toast.warning(message);
        });
        try {
          sessionStorage.setItem(`vibebuild:pendingPrompt:${created}`, prompt);
        } catch { /* ignore */ }
      }
      if (launched.data.warnings?.some(w => w?.step === "figma")) {
        toast.warning(t("workspace.figma.pendingConnectFailed"));
      }
      clearDraftPrompt();
      router.push(`/project/${created}`);
      navigating = true;
      return;
    }

    const res = await vcaasApi.projects.create({
      projectId: id,
      description: prompt.slice(0, 200),
      projectType: promptMode,
      engineVersion: "v2",
    });
    if (!res.ok || !res.data) {
      setBuildError(res.error || `Could not create "${id}".`);
      return;
    }
    /**
     * ⚠️ THE CREATED ID, NOT THE REQUESTED ONE. A taken name is no longer an error:
     * the API creates `my-app-k7` and says so, and every call from here on — Figma,
     * the uploads, the stash, the navigation — must go to the project that exists.
     */
    const requested = id;
    const id2 = res.data?.projectId || requested;
    if (id2 !== requested) toast.info(`"${requested}" was taken — your project is "${id2}".`);
    /**
     * ⭐ CONNECT FIGMA NOW THAT THERE IS A PROJECT — before the prompt is stashed, since
     * the workspace runs it on arrival. A failure here does not fail the creation: the
     * project exists and has been paid for, so say Figma did not connect and move on.
     */
    if (figmaToken) {
      const figma = await vcaasApi.figma.connect(id2, { token: figmaToken });
      setFigmaToken(null);
      if (!figma.ok) toast.warning(t("workspace.figma.pendingConnectFailed"), { description: figma.error || undefined });
    }
    // Upload the attachments so the agent gets real, publicly-fetchable URLs (blob URLs
    // from the browser can't be read by the agent and don't survive navigation). The
    // upload endpoint needs the project to exist first, which is why this runs after
    // creation.
    let uploadedFiles: { name: string; url: string; imageDescription: string }[] = [];
    setUploading(true);
    // Retries built in — a just-created project's storage can need a moment.
    const upload = await uploadFilesToProjectDetailed(id2, attachedFiles.map((f) => f.file));
    uploadedFiles = upload.uploaded;
    setUploading(false);
    // ⚠️ NAME THE FILE AND THE REASON. "Some attachments could not be uploaded" left the
    // user guessing which of four photos the agent will never see, and why.
    for (const failure of upload.failed) {
      toast.error(`${failure.name}: ${failure.reason}`, { description: "The agent will not see this file." });
    }
    // Stash the first prompt (and uploaded files, with real URLs) so the workspace auto-submits it.
    try {
      sessionStorage.setItem(`vibebuild:pendingPrompt:${id2}`, prompt);
      if (uploadedFiles.length > 0) sessionStorage.setItem(`vibebuild:pendingFiles:${id2}`, JSON.stringify(uploadedFiles));
    } catch { /* ignore */ }
    clearDraftPrompt();
    router.push(`/project/${id2}`);
    navigating = true;
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Could not create the project. Please try again.");
    } finally {
      if (!navigating) {
        buildCreatingRef.current = false;
        setBuildCreating(false);
      }
    }
  };

  // Keep the raw File objects around — we can't upload here because the project
  // doesn't exist yet, and blob URLs die on navigation. The real upload happens in
  // submitBuild once the project is created (see uploadFilesToProject).
  /**
   * ⭐ THE SIZE IS CHECKED AT ATTACH TIME, NOT AT BUILD TIME. Nothing is uploaded from
   * this screen — the project does not exist yet — so an oversized file would otherwise
   * sit in the tray looking fine and be dropped minutes later, after the project was
   * created and the user had walked away.
   */
  const attachLocalFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const { allowed, tooLarge } = splitBySize(files);
    if (tooLarge.length === 1) {
      toast.error(t("prompt.attachments.tooLarge", { name: tooLarge[0].name, size: MAX_UPLOAD_MB }), { description: TOO_LARGE_ADVICE });
    } else if (tooLarge.length > 1) {
      toast.error(t("prompt.attachments.tooLargeMany", { count: tooLarge.length, size: MAX_UPLOAD_MB }), { description: TOO_LARGE_ADVICE });
    }
    if (allowed.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...allowed.map((file) => ({ name: file.name, imageDescription: file.name, file }))]);
  }, [t]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    attachLocalFiles(files);
    e.target.value = "";
  };

  /**
   * ⭐ ⌘/Ctrl+V ATTACHES WHAT IS ON THE CLIPBOARD — a screenshot, or a file copied in
   * the file manager. Same rule as the workspace chat: `filesFromClipboard` refuses when
   * the clipboard carries real text, so a Word or Excel paste stays text.
   */
  const handleHeroPaste = useCallback((event: React.ClipboardEvent) => {
    const pasted = filesFromClipboard(event.clipboardData);
    if (!pasted.length) return;
    event.preventDefault();
    attachLocalFiles(pasted);
  }, [attachLocalFiles]);

  // Perform the actual deletion once the user confirms in the modal.
  const confirmDelete = async () => {
    const projectId = deleteTarget;
    if (!projectId) return;
    setDeleting(true);
    const res = await vcaasApi.projects.remove(projectId);
    if (res.ok) {
      toast.success("Project deleted");
      setProjects((prev) => prev.filter((p) => p.projectId !== projectId));
      setDeleteTarget(null);
    } else {
      toast.error(res.error || "Failed to delete project");
    }
    setDeleting(false);
  };

  const hasProjects = projects.length > 0;

  return (
    <div className="min-h-screen relative overflow-hidden mavly-page-enter">
      <div className="fixed inset-0 -z-10" style={{ background: "#fcfbf8" }} />

      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#fcfbf8]/80 backdrop-blur-md border-b border-black/[0.04]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2.5 group select-none">
            <Image
              src="/logo/Mavly.png"
              alt="Mavly Logo"
              width={28}
              height={28}
              className="w-7 h-7 rounded-lg object-contain shadow-xs shrink-0 transition-transform group-hover:scale-105 active:scale-95"
              priority
              referrerPolicy="no-referrer"
            />
            <span className="font-semibold tracking-tight text-gray-900 text-sm">Mavly</span>
          </Link>
          <div className="flex items-center gap-2">
            <AuthNav profile={profile} />
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Hero prompt */}
        <div className="mb-10">
          <div className="w-full max-w-3xl mx-auto">
            <div className="text-center mb-6">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-4 shadow-[0_4px_16px_rgba(0,0,0,0.06)] overflow-hidden flex items-center justify-center p-1 bg-white border border-black/[0.06]">
                <Image
                  src="/logo/Mavly.png"
                  alt="Mavly Logo"
                  width={56}
                  height={56}
                  className="w-full h-full object-contain"
                  priority
                  referrerPolicy="no-referrer"
                />
              </div>
              <h1 className={`font-bold tracking-tight text-gray-900 ${hasProjects ? "text-xl" : "text-3xl sm:text-4xl"}`}>
                What do you want to build?
              </h1>
              {promptMode === "android" ? (
                <p className="text-gray-500 max-w-md mx-auto mt-2 text-sm">
                  Mavly generates native Kotlin and Jetpack Compose source. Debug APK builds are available only where an operator enables them for this project; emulator previews, release signing, AAB and store publishing are not configured. Local attachments are not transferred.
                </p>
              ) : (
                !hasProjects && <p className="text-gray-500 max-w-md mx-auto mt-2 text-sm">Describe your app and AI will build it in minutes.</p>
              )}
            </div>
            <div className="mb-2 px-4 sm:px-5">
              <div role="group" aria-label="Build mode" className="inline-flex max-w-full gap-1 rounded-xl bg-gray-100 p-1">
                <button
                  type="button"
                  aria-pressed={promptMode === "website"}
                  onClick={() => setPromptMode("website")}
                  disabled={buildCreating}
                  className={`inline-flex h-10 min-w-[100px] items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-w-[116px] ${
                    promptMode === "website"
                      ? "border-black/[0.06] bg-white text-gray-900 shadow-sm"
                      : "border-transparent bg-transparent text-gray-500 hover:bg-white/70 hover:text-gray-800"
                  }`}
                >
                  <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">Website</span>
                </button>
                <button
                  type="button"
                  aria-pressed={promptMode === "android"}
                  onClick={() => setPromptMode("android")}
                  disabled={buildCreating}
                  className={`inline-flex h-10 min-w-[100px] items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-w-[116px] ${
                    promptMode === "android"
                      ? "border-black/[0.06] bg-white text-gray-900 shadow-sm"
                      : "border-transparent bg-transparent text-gray-500 hover:bg-white/70 hover:text-gray-800"
                  }`}
                >
                  <Smartphone className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">Android App</span>
                </button>
              </div>
            </div>
            <div className="relative bg-white rounded-2xl sm:rounded-3xl shadow-[0_8px_30px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.02)] border border-black/[0.08] overflow-hidden transition-all duration-200 focus-within:border-black/40 focus-within:shadow-[0_12px_36px_rgba(0,0,0,0.06)]">
              <div className="relative">
                <textarea
                  ref={heroTextareaRef}
                  value={firstPrompt}
                  onChange={(e) => {
                    setFirstPrompt(e.target.value);
                    if (buildError) setBuildError(null);
                  }}
                  disabled={buildCreating}
                  onFocus={() => setHeroFocused(true)}
                  onBlur={() => setHeroFocused(false)}
                  placeholder={
                    promptMode === "website"
                      ? "Describe what you want to build..."
                      : "Describe the Android app you want to build..."
                  }
                  className="block w-full min-h-[140px] sm:min-h-[170px] resize-none text-[15px] leading-relaxed p-5 pb-3 outline-none placeholder:text-gray-400 bg-transparent"
                  onKeyDown={(e) => {
                    // Enter submits, Shift+Enter is a newline (the box is a textarea).
                    if (shouldSubmitPrompt(e.key, e.shiftKey)) {
                      e.preventDefault();
                      void submitBuild();
                    }
                  }}
                  onPaste={handleHeroPaste}
                />
                {/*
                  ⭐ The animated placeholder sits over the textarea only; it must not
                  cover the mode selector above it.
                */}
                <AnimatedPlaceholder active={heroAnimated} />
              </div>
              {/*
                ⭐ The attachments, previewed. Nothing is uploaded yet here — the project
                does not exist — so an image is shown from the browser's own copy through
                an object URL. See `AttachmentPreview.tsx`.
              */}
              <AttachmentPreviews
                className="px-5 pb-2"
                items={attachedFiles.map((f) => ({ name: f.name, file: f.file, type: f.file.type, size: f.file.size }))}
                onRemove={(index) => setAttachedFiles((prev) => prev.filter((_, j) => j !== index))}
              />
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-black/[0.05]">
                <div className="flex items-center gap-1">
                  <label className="cursor-pointer flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors px-2 py-1.5 rounded-lg hover:bg-black/5 active:scale-95">
                    <input type="file" multiple className="hidden" onChange={handleFileSelect} accept="image/*,.pdf,.svg" />
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                    <span className="hidden sm:inline">Attach</span>
                  </label>
                  {/* ⭐ Figma in the hero tray — pending mode, see `figmaToken`. */}
                  <FigmaPromptButton
                    onAdd={appendToPrompt}
                    hasText={firstPrompt.trim().length > 0}
                    onConnect={() => setFigmaModalOpen(true)}
                    connected={!!figmaToken}
                    onDisconnect={() => {
                      setFigmaToken(null);
                      toast.success(t("workspace.figma.pendingForgotten"));
                    }}
                    disconnectConfirm={t("workspace.figma.disconnectPendingConfirm")}
                  />
                  {/* ⭐ GitHub, beside Figma. Reuses the workspace's import modal. */}
                  <GithubPromptButton onOpenModal={openGithubImport} />
                </div>
                <button
                  onClick={() => void submitBuild()}
                  disabled={!firstPrompt.trim() || buildCreating}
                  className="mavly-btn-primary px-4 h-8 text-xs font-semibold disabled:opacity-40 disabled:pointer-events-none"
                >
                  {buildCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>{buildCreating ? "Creating..." : "Build"}</span>
                </button>
              </div>
            </div>
            {buildError && (
              <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{buildError} Your prompt is still here; you can correct it and retry.</span>
              </div>
            )}
          </div>
        </div>

        {/* Projects */}
        {hasProjects && (
          <>
            {/* Toolbar: search, sort, view toggle */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-gray-700">Projects</h2>
                <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{filtered.length}</span>
              </div>

              <div className="flex-1 flex flex-wrap items-center gap-2 sm:justify-end">
                {/* Search */}
                <div className="relative flex-1 sm:flex-none sm:w-56 min-w-[160px]">
                  <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name or description..."
                    className="w-full h-8 pl-8 pr-7 text-xs rounded-lg border border-gray-200 bg-white/70 text-gray-700 outline-none focus:ring-2 focus:ring-gray-200"
                  />
                  {search && (
                    <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Sort */}
                <div className="relative">
                  <ArrowUpDown className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="h-8 pl-8 pr-6 text-xs rounded-lg border border-gray-200 bg-white/70 text-gray-700 outline-none focus:ring-2 focus:ring-gray-200 appearance-none cursor-pointer"
                  >
                    <option value="date-desc">Newest first</option>
                    <option value="date-asc">Oldest first</option>
                    <option value="name-asc">Name A–Z</option>
                    <option value="name-desc">Name Z–A</option>
                  </select>
                </div>

                {/* View toggle */}
                <div className="flex items-center rounded-lg border border-gray-200 bg-white/70 p-0.5">
                  <button
                    onClick={() => chooseView("cards")}
                    title="Card view"
                    className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${resolvedView === "cards" ? "bg-gray-900 text-white" : "text-gray-400 hover:text-gray-600"}`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => chooseView("table")}
                    title="Table view"
                    className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${resolvedView === "table" ? "bg-gray-900 text-white" : "text-gray-400 hover:text-gray-600"}`}
                  >
                    <TableIcon className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/*
                  ⭐ IMPORT — the other half of Export. It creates a fresh project and
                  restores the code INTO it, because an import always drops whatever is in
                  the target first and upstream refuses a target that is not nearly empty.
                */}
                <button
                  onClick={() => setImportOpen(true)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 h-8 px-2.5 rounded-lg border border-gray-200 bg-white/70 hover:bg-white transition-colors"
                  title="Import a project from a code"
                >
                  <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Import</span>
                </button>

                {/* ⭐ New project = focus the composer. See `focusComposer`. */}
                <button
                  onClick={focusComposer}
                  className="mavly-btn-secondary h-8 px-3 text-xs font-semibold"
                  title="New project"
                >
                  <Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">New</span>
                </button>
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <Search className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                <p className="text-sm">No projects match &ldquo;{search}&rdquo;</p>
              </div>
            ) : resolvedView === "cards" ? (
              /* ── CARD VIEW ── */
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pageItems.map((p) => {
                  const name = displayProjectName(p);
                  const updated = formatProjectDate(p);
                  return (
                    <Link key={p.projectId} href={`/project/${p.projectId}`} className="block h-full">
                      <div className="bg-white rounded-2xl border border-black/[0.06] shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)] hover:shadow-[0_12px_32px_-4px_rgba(0,0,0,0.08)] hover:border-black/[0.12] hover:-translate-y-1 active:translate-y-0 transition-all duration-300 overflow-hidden cursor-pointer group h-full flex flex-col">
                        <div className="aspect-[16/10] relative overflow-hidden border-b border-black/[0.04]">
                          {p.projectType === "android" ? (
                            <AndroidProjectPlaceholder isRow={false} />
                          ) : (
                            <ProjectPreview project={p} />
                          )}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors pointer-events-none" />
                        </div>
                        <div className="p-4 flex-1">
                          <div className="flex items-start justify-between mb-1">
                            <h3 className="font-medium text-sm text-gray-800 group-hover:text-gray-900 truncate flex-1" title={name}>
                              {name}
                            </h3>
                            {p.projectType === "android" && (
                              <span className="ml-2 shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[9px] font-medium text-gray-500">
                                Android
                              </span>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                  title="Options"
                                  className="w-6 h-6 rounded-md flex items-center justify-center text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-all shrink-0 ml-2"
                                >
                                  <MoreVertical className="w-3.5 h-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                                {/* ⭐ Duplicate = export + create + import behind one action. */}
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  onSelect={(e) => { e.preventDefault(); setCloneTarget(p.projectId); }}
                                >
                                  <Copy className="w-3.5 h-3.5 mr-2" /> Duplicate
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  onSelect={(e) => { e.preventDefault(); setExportTarget(p.projectId); }}
                                >
                                  <Upload className="w-3.5 h-3.5 mr-2" /> Export…
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-red-600 focus:text-red-600 focus:bg-red-50 cursor-pointer"
                                  onSelect={(e) => { e.preventDefault(); setDeleteTarget(p.projectId); }}
                                >
                                  <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          <p className="text-[11px] text-gray-500 line-clamp-1">{p.description || "No description"}</p>
                          <div className="flex items-center justify-between mt-2">
                            <span className="text-[10px] text-gray-400">
                              {updated ? `Updated ${updated}` : ""}
                            </span>
                            <ArrowRight className="w-3 h-3 text-gray-300 group-hover:text-gray-500 transition-colors" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              /* ── TABLE VIEW ── */
              <div className="bg-white/70 backdrop-blur-sm border border-gray-200/60 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-gray-200/70 text-[11px] uppercase tracking-wider text-gray-400">
                        <th className="font-medium px-4 py-2.5 w-16">Preview</th>
                        <th className="font-medium px-2 py-2.5">Project</th>
                        <th className="font-medium px-2 py-2.5 hidden md:table-cell">Description</th>
                        <th className="font-medium px-2 py-2.5 whitespace-nowrap">Updated</th>
                        <th className="font-medium px-4 py-2.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageItems.map((p) => (
                        <tr
                          key={p.projectId}
                          onClick={() => router.push(`/project/${p.projectId}`)}
                          className="border-b border-gray-100/70 last:border-0 hover:bg-gray-50/60 cursor-pointer transition-colors group"
                        >
                          <td className="px-4 py-2">
                            <div className="relative w-14 aspect-[16/10] rounded-md overflow-hidden border border-gray-200/60">
                              {p.projectType === "android" ? (
                                <AndroidProjectPlaceholder isRow />
                              ) : (
                                <ProjectPreview project={p} variant="row" />
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <span className="text-sm font-medium text-gray-800 group-hover:text-gray-900" title={displayProjectName(p)}>
                              {displayProjectName(p)}
                            </span>
                            {p.projectType === "android" && (
                              <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[9px] font-medium text-gray-500">
                                Android
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 hidden md:table-cell">
                            <span className="text-xs text-gray-500 line-clamp-1 max-w-[280px]">{p.description || "No description"}</span>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            <span className="text-xs text-gray-400">{formatProjectDate(p)}</span>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                  title="Options"
                                  className="w-6 h-6 rounded-md inline-flex items-center justify-center text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-all"
                                >
                                  <MoreVertical className="w-3.5 h-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  onSelect={(e) => { e.preventDefault(); setCloneTarget(p.projectId); }}
                                >
                                  <Copy className="w-3.5 h-3.5 mr-2" /> Duplicate
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  onSelect={(e) => { e.preventDefault(); setExportTarget(p.projectId); }}
                                >
                                  <Upload className="w-3.5 h-3.5 mr-2" /> Export…
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-red-600 focus:text-red-600 focus:bg-red-50 cursor-pointer"
                                  onSelect={(e) => { e.preventDefault(); setDeleteTarget(p.projectId); }}
                                >
                                  <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Pagination */}
            {filtered.length > PAGE_SIZE && (
              <div className="flex items-center justify-center gap-2 mt-6">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="h-8 w-8 flex items-center justify-center rounded-lg border border-gray-200 bg-white/70 text-gray-500 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-gray-500 px-2">Page {safePage} of {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="h-8 w-8 flex items-center justify-center rounded-lg border border-gray-200 bg-white/70 text-gray-500 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </>
        )}

        {loading && hasProjects && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-48 rounded-xl bg-gray-200/60 dark:bg-gray-800/60" />)}
          </div>
        )}
      </div>

      {/* ⭐ The empty project the existing GitHub import dialog will target. */}
      <Dialog
        open={githubNameModalOpen}
        onOpenChange={(open) => {
          if (!githubNameCreating) setGithubNameModalOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader><DialogTitle>Create a project for GitHub</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-4">
            <p className="text-sm text-gray-500">
              Mavly imports a repository into a project. Name the project first, then choose
              the repository and branch in the GitHub dialog.
            </p>
            <div>
              <Label>Project name</Label>
              <Input
                autoFocus
                placeholder="github-import"
                value={githubName}
                onChange={(e) => {
                  setGithubName(e.target.value);
                  if (githubNameError) setGithubNameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !githubNameCreating) void confirmGithubProject();
                }}
                className="mt-1.5"
              />
              <p className="text-xs text-gray-400 mt-1">
                3-35 chars, lowercase, hyphens allowed. Final id:{" "}
                <span className="font-mono text-gray-500">{normalizeId(githubName) || "…"}</span>
              </p>
            </div>
            {githubNameError && (
              <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{githubNameError}</span>
              </div>
            )}
            <Button
              className="w-full"
              onClick={() => void confirmGithubProject()}
              disabled={githubNameCreating || normalizeId(githubName).length < 3}
            >
              {githubNameCreating
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...</>
                : <><ArrowRight className="w-4 h-4 mr-2" /> Continue to GitHub</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Beautiful destructive confirmation modal */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-md overflow-hidden p-0 gap-0">
          {/* Red accent header */}
          <div className="relative bg-gradient-to-br from-red-50 to-rose-100/60 px-6 pt-7 pb-6 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-white shadow-sm ring-1 ring-red-100 flex items-center justify-center">
              <AlertTriangle className="w-7 h-7 text-red-500" />
            </div>
            <DialogHeader className="mt-4">
              <DialogTitle className="text-center text-lg font-semibold text-gray-900">Delete this project?</DialogTitle>
            </DialogHeader>
          </div>

          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-600 text-center leading-relaxed">
              You&rsquo;re about to permanently delete{" "}
              <span className="font-semibold text-gray-900 font-mono break-all">{deleteTarget}</span>.
            </p>
            <div className="flex items-start gap-2.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>This action is <strong>irreversible</strong>. Once deleted, the project and all its data cannot be recovered.</span>
            </div>

            <div className="flex gap-2.5 pt-1">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
                ) : (
                  <><Trash2 className="w-4 h-4 mr-2" /> Delete forever</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/*
        ⭐ FIGMA, PENDING MODE — no `projectId`. The modal validates the token against Figma
        and hands it back; nothing is stored until `submitBuild` connects it to the project
        it just made. Reusing the modal is deliberate: the how-to steps, the scopes and the
        security note are the reason people trust pasting a token.
      */}
      <FigmaModal
        open={figmaModalOpen}
        onOpenChange={setFigmaModalOpen}
        onStatusChange={() => { /* no project yet — `figmaToken` drives the tint */ }}
        onPendingToken={token => setFigmaToken(token)}
      />

      {/*
        ⭐ THE WORKSPACE'S GITHUB DIALOG, UNCHANGED. It targets the project created
        above and, on a completed import, sends the user to that project's workspace.
      */}
      {githubProjectId ? (
        <GithubModal
          open={githubModalOpen}
          onOpenChange={setGithubModalOpen}
          projectId={githubProjectId}
          onStatusChange={() => { /* the dashboard has no connected dot */ }}
          onProjectChanged={() => {
            setGithubModalOpen(false);
            router.push(`/project/${githubProjectId}`);
          }}
        />
      ) : null}

      {/* ═══ EXPORT · IMPORT · DUPLICATE — totalum-platform's dialogs, unchanged ═══ */}
      <ExportProjectDialog
        open={exportTarget !== null}
        onOpenChange={open => {
          if (!open) setExportTarget(null);
        }}
        projectId={exportTarget ?? ""}
      />
      <ImportProjectDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        takenNames={takenNames}
        onImported={fetchData}
      />
      <CloneProjectDialog
        open={cloneTarget !== null}
        onOpenChange={open => {
          if (!open) setCloneTarget(null);
        }}
        projectId={cloneTarget ?? ""}
        takenNames={takenNames}
        onCloned={fetchData}
      />
    </div>
  );
}
