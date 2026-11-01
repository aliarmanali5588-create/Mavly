"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { vcaasApi } from "@/lib/vcaas";
import { githubApi } from "@/lib/github-client";
import { Button } from "@/components/ui/button";
import {
  Rocket, Loader2, Eye, LayoutGrid, Key, Globe,
  RefreshCw, Server, PanelLeftClose, PanelLeft, Monitor, Smartphone,
  ExternalLink, Sparkles, ChevronDown, FolderOpen, Plus,
  Clock, Github, Code2, ArrowLeft, Figma, Copy,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { AndroidWorkspace } from "@/components/workspace/AndroidWorkspace";
import { PreviewPanel } from "@/components/workspace/PreviewPanel";
import { LiveRuntimePreview } from "@/components/workspace/LiveRuntimePreview";
import { useRunProgress } from "@/components/workspace/RunActivity";
import { isRunOver } from "@/lib/run-progress";
import { WorkspaceMore } from "@/components/workspace/v2/WorkspaceMore";
import { V2Banner } from "@/components/workspace/v2/V2Banner";
import { CodePanel, invalidateCodeCache } from "@/components/workspace/CodePanel";
import { VersionsModal } from "@/components/workspace/VersionsModal";
import { SecretsModal } from "@/components/workspace/SecretsModal";
import { ProjectDomainPanel } from "@/components/workspace/v2/ProjectDomainPanel";
import { GithubModal } from "@/components/workspace/GithubModal";
import { CreditsIndicator } from "@/components/workspace/CreditsIndicator";
import { CloneProjectDialog } from "@/components/workspace/ProjectTransferDialogs";
import { DiffViewer, type DiffSource } from "@/components/workspace/DiffViewer";
import { ConfirmDialog } from "@/components/primitives";
import { ImportOverlay } from "@/components/workspace/ImportOverlay";
import { PathPicker } from "@/components/workspace/PathPicker";
import { looksLikePlaceholder } from "@/lib/preview-health";
import {
  importWatchVerdict,
  IMPORT_IDLE_POLLS_BEFORE_READINESS,
} from "@/lib/import-watch";
import type { VcaasProject, ConversationMessage, ProjectVersion, AgentRunOptions, AgentInputFile, DeploymentStatus } from "@/lib/vcaas-types";
import { loadAttachments, saveAttachments } from "@/lib/composer-attachments";
import { useServerWake } from "@/components/workspace/use-server-wake";
import { useAgentCompletionSounds } from "@/components/workspace/useAgentCompletionSounds";
import { ServerWakeNotice } from "@/components/workspace/ServerWakeNotice";
import { ServerBlockedDialog, useServerBlocked } from "@/components/workspace/ServerBlockedDialog";
import { FigmaModal } from "@/components/workspace/FigmaModal";
import { OperationBanner } from "@/components/workspace/OperationBanner";
import { useProjectOperation } from "@/components/workspace/use-project-operation";
import { OPERATION_COPY, OPERATION_PROFILES } from "@/lib/project-operation";
import { getPublishedHost, getPreviewUrlField, isV2Project } from "@/lib/project-status";
import { optionsForEngine } from "@/lib/run-options";
import { useVisualEditor } from "@/components/workspace/visual-editor/use-visual-editor";
import { VisualEditorPanel } from "@/components/workspace/visual-editor/VisualEditorPanel";
import { VisualChangesBar } from "@/components/workspace/visual-editor/VisualChangesBar";
import { t as translate } from "@/i18n";

// Pick the correct development preview URL following the Totalum API docs:
// use `developmentUrlFieldToUse` to decide between the live server URL and the
// cached static snapshot; default to `temporalDevelopmentProjectUrl` if null/undefined.
function getPreviewUrlFromProject(proj: VcaasProject): string | null {
  const field = proj.developmentUrlFieldToUse || "temporalDevelopmentProjectUrl";
  const url = (proj as unknown as Record<string, unknown>)[field] || proj.temporalDevelopmentProjectUrl;
  return (url as string) || null;
}

// True when the preview being shown is the cached snapshot (dev server not active).
function isCachedPreview(proj: VcaasProject): boolean {
  return proj.developmentUrlFieldToUse === "cachedDevelopmentUrl";
}

type PendingAgentStartRequest = {
  fingerprint: string;
  clientRequestId: string;
};

type StoredAgentStartRequest = PendingAgentStartRequest & {
  accepted: boolean;
};

function agentStartRequestStorageKey(projectId: string): string {
  return `mavly:agent-start:${projectId}`;
}

async function agentStartRequestFingerprint(payload: unknown): Promise<string> {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error("Agent request could not be serialized.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pendingAgentStartRequest(value: unknown): StoredAgentStartRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.fingerprint) ||
    typeof record.clientRequestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.clientRequestId,
    )
  ) {
    return null;
  }
  return {
    fingerprint: record.fingerprint,
    clientRequestId: record.clientRequestId,
    accepted: record.accepted === true,
  };
}

/**
 * ⭐ A PROJECT READ OLDER THAN THIS IS RE-CHECKED WHEN THE USER COMES BACK — see the
 * "stale tab" effect. The hourly archive job puts an idle sandbox to sleep while the tab
 * stays open, so the preview kept a dead live url (Cloudflare's "not available" page).
 */
const STALE_PROJECT_MS = 5 * 60_000;

/**
 * No live server behind this project: `Archived`, or no status at all while upstream
 * recommends the archive snapshot. ⚠️ Production sends NO `agentServerStatus` for a
 * sleeping project (checked 2026-09-14), so `=== "Archived"` alone never matched.
 */
function hasNoLiveServer(proj: VcaasProject | null): boolean {
  if (!proj) return false;
  return proj.agentServerStatus === "Archived" || (!proj.agentServerStatus && isCachedPreview(proj));
}

/**
 * ═══⭐⭐ THE MODALS — YOU CONSULT THEM AND COME BACK ═══════════════════════════
 *
 * Versions, secrets, the custom domain, GitHub and Figma used to be TABS in the panel
 * column, which put "restore a version" on the same footing as "look at the preview".
 * They are not places you work; they are errands. totalum-platform renders each as a
 * dialog over the workspace and so does this page now — one string names the open one,
 * so two can never be open at once.
 */
type WorkspaceModal = "versions" | "secrets" | "domain" | "github" | "figma";

/** Publishing takes ~3 minutes; 90 × 10s leaves room for a slow Vercel build. */
const DEPLOY_POLL_INTERVAL_MS = 10_000;
const DEPLOY_POLL_MAX_ATTEMPTS = 90;

/**
 * ⭐ A PERMANENT "THERE IS NO PROVIDER" IS NOT A TRANSIENT FAILURE.
 *
 * `GET …/deployments/status` answers `503 BACKEND_NOT_CONFIGURED` when customer
 * publishing is not configured for this deployment. Retrying that is pure noise:
 * nothing about the next attempt differs from this one. When that exact refusal is
 * seen the watcher stops at once and the user is told there is no provider.
 *
 * ⚠️ THE STATUS CODE ALONE IS NOT THAT REFUSAL. A gateway or origin failure also
 * answers 503, and `proxyRequest` reports it as `code: "UNKNOWN"` (the body is an
 * HTML error page, not the app's JSON envelope). Treating every 503 as permanent
 * would abandon a genuinely transient failure on its first attempt AND tell the
 * user "no deployment provider is configured" — a claim that response cannot
 * support. Everything except the exact refusal keeps the existing bounded retry
 * budget (90 × 10 s), because a 502, a 429, a timeout or a dropped connection can
 * all genuinely clear.
 */
function isPublishingUnavailable(response: {
  ok?: boolean;
  code?: string;
  status?: number;
}): boolean {
  if (response.ok) return false;
  return response.code === "BACKEND_NOT_CONFIGURED";
}

/**
 * One shared empty list, so "this project has no attachments" is always the SAME
 * array. A fresh `[]` per render would change identity every time and re-run every
 * effect and memo downstream of it.
 */
const EMPTY_ATTACHMENTS: AgentInputFile[] = [];

/** The splitter's drag boundaries, kept in sync with the panel's inline width. */
const CHAT_MIN_WIDTH = 280;
const CHAT_MAX_WIDTH = 600;
/** The desktop header's left cell ends where the chat column plus the divider does. */
const CHAT_DIVIDER_WIDTH = 5;

/**
 * The entities the upstream sanitiser produces. `&amp;` is the one that matters — it
 * sits between every query parameter of a signed URL — but a file NAME can carry any
 * of the others, and a chip labelled `photo &#39;final&#39;.png` is its own small bug.
 */
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2F;": "/",
  "&#47;": "/",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|#x2F|#47);/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

/**
 * A persisted message's attachments, made renderable — or `undefined` when there are
 * none, so a message without files is left byte-identical rather than given an empty
 * array that would re-render every chip list downstream.
 *
 * ⚠️ TRUST NOTHING IN THE SHAPE. This crosses a network boundary; a row missing its
 * `url` would render a chip that links nowhere.
 */
function decodeAttachments(files: AgentInputFile[] | undefined): AgentInputFile[] | undefined {
  if (!files?.length) return undefined;
  const decoded = files
    .filter((file) => file && typeof file.name === "string" && typeof file.url === "string")
    .map((file) => ({
      name: decodeEntities(file.name),
      url: decodeEntities(file.url),
      imageDescription: decodeEntities(file.imageDescription ?? file.name),
    }));
  return decoded.length ? decoded : undefined;
}

/**
 * Resolves once the project's dev app is served again (not the sandbox placeholder),
 * or after ~2 minutes regardless — the caller reloads the frame either way.
 */
async function waitForPreview(projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`/api/preview/${encodeURIComponent(projectId)}/`, { cache: "no-store" });
      if (response.ok && !looksLikePlaceholder(await response.text())) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export default function WorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const completionSounds = useAgentCompletionSounds(projectId);

  /**
   * ═══⭐⭐ THE SLEEPING SANDBOX, AND THE ONE PLACE THAT EXPLAINS IT ═════════
   *
   * A project whose sandbox has been archived cannot be written to, rebuilt, published,
   * synced or restored: the API starts the server itself and refuses the action with
   * `SERVER_NOT_READY`. `useServerWake` turns that refusal into a wait with a clock, and
   * `useServerBlocked` + `<ServerBlockedDialog>` turn it into a sentence the user can act
   * on. Both are lifted from totalum-platform unchanged — see the notes in those files.
   */
  const serverWake = useServerWake(projectId);

  /**
   * ═══⭐⭐⭐ TOUCHING THE PROJECT STARTS ITS SLEEPING SERVER ═════════════════
   *
   * A sandbox is archived after a spell of inactivity, and an archived project opens
   * onto a dead end: the preview is a cached snapshot, and the first real thing the
   * user does — send a prompt, save a file, publish, pull — comes back
   * `SERVER_NOT_READY` two or three minutes before it could have worked. Starting it
   * when they engage means that wait overlaps with them reading their project instead
   * of following it.
   *
   * ⚠️⚠️ MERELY OPENING THE PAGE IS NOT ENOUGH, and that is the whole point of the
   * latch. Opening a project is the cheapest thing a user does: a link from the
   * dashboard, a bookmark, a tab the browser restored, a glance at a preview. Starting
   * a server for each of those spends credits and minutes of machine time on something
   * nobody was going to use. The project has to be TOUCHED first.
   *
   * ⚠️ THE HEADER IS EXCLUDED ON PURPOSE — totalum-platform does the same. It is
   * scaffolding, not the project: the project name, the theme toggle, the menu,
   * Dashboard. Clicking those is usually how someone LEAVES, and waking a server on the
   * way out is the same waste in a costlier disguise.
   *
   * ⚠️ A ONE-WAY LATCH, HELD IN A REF AS WELL AS IN STATE. The ref is what the listener
   * reads, so it never has to re-subscribe; the state is what re-runs the start effect,
   * which is otherwise idle.
   */
  const workspaceTouched = useRef(false);
  const [touchedProject, setTouchedProject] = useState(false);

  // A different project has not been touched yet, whatever the last one had.
  useEffect(() => {
    workspaceTouched.current = false;
    setTouchedProject(false);
  }, [projectId]);

  const markWorkspaceTouched = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (workspaceTouched.current) return;
    // `closest`, not the event's own currentTarget: a click can land on any node inside
    // the header (an icon, inside a button, inside the menu trigger).
    if ((event.target as HTMLElement | null)?.closest?.("[data-workspace-header]")) return;
    workspaceTouched.current = true;
    setTouchedProject(true);
  }, []);
  const [openModal, setOpenModal] = useState<WorkspaceModal | null>(null);
  const [leaveWorkspaceOpen, setLeaveWorkspaceOpen] = useState(false);
  const [leaveWorkspaceHref, setLeaveWorkspaceHref] = useState("/dashboard");
  /**
   * ⭐ DUPLICATE, FROM THE PROJECT MENU. The dialog is the dashboard's (export → create →
   * import behind one button) and it wants the names already in use to suggest a free
   * copy name, so the list is fetched when the menu entry is pressed, not on every load.
   */
  const [cloneOpen, setCloneOpen] = useState(false);
  const [takenNames, setTakenNames] = useState<ReadonlySet<string>>(() => new Set());
  const openClone = useCallback(async () => {
    const res = await vcaasApi.projects.list({ limit: 100 });
    if (res.ok && Array.isArray(res.data)) setTakenNames(new Set(res.data.map((p) => p.projectId)));
    setCloneOpen(true);
  }, []);
  const [figmaConnected, setFigmaConnected] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);

  /**
   * ═══⭐⭐ THE LONG OPERATIONS, AND THE BANNER THAT OWNS THEM ═══════════════
   *
   * Publish, GitHub pull, restore-a-version and restart-the-server all take
   * minutes, all take the app down or replace it while they run, and all used to be
   * invisible the moment the toast faded. `useProjectOperation` records the one in flight
   * (persisted, so a reload does not lose it) and `<OperationBanner>` renders it with a
   * clock and an honest progress estimate. Copied from totalum-platform unchanged.
   *
   * ⚠️ ONE SLOT, DELIBERATELY. Two of these at once would be two builds racing on the
   * same sandbox, so starting one while another runs is refused rather than queued.
   */
  const operation = useProjectOperation(projectId);
  /**
   * ⭐ THE PUBLISH/PUBLISHED DIALOG, AND THE STATE THAT FILLS IT.
   *
   * `deploymentStatus` is the authoritative answer from
   * `GET …/deployments/status` — never inferred from the page's own request
   * history. It is re-read on mount, whenever a publish/unpublish settles, and
   * every ten seconds while either operation is still in flight, so an unpublish
   * started in another tab is reflected here instead of leaving a dead URL on
   * screen.
   */
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus | null>(null);
  /**
   * ⭐ THE BACKEND HAS NO DEPLOYMENT PROVIDER — AND SAYS SO. `deployments/status`
   * answers `503 BACKEND_NOT_CONFIGURED` on every deployment where customer publishing
   * is not configured. That is an accurate answer, not a failure to retry: polling it
   * (the mount fallback and the ten-second watcher both did) spent the whole bounded
   * retry budget on a permanent condition and then told the user "refresh in a moment
   * to see the current state". This flag records the once-read answer so nothing polls
   * it again and no publish/status UI claims a deployment state it cannot know.
   */
  const [publishingUnavailable, setPublishingUnavailable] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const restoringVersion = operation.kind === "restoreVersion";

  /**
   * ⭐ WHY A CONTROL IS REFUSED RIGHT NOW, IN WORDS. Every long operation is also
   * disabled while ITS OWN kind runs; this covers the case the disabled state cannot —
   * pressing "pull" during a publish — with the sentence the platform uses.
   */
  const operationBusyReason = operation.kind
    ? translate(OPERATION_COPY[operation.kind].blocked, {
        min: OPERATION_PROFILES[operation.kind].minMinutes,
        max: OPERATION_PROFILES[operation.kind].maxMinutes,
      })
    : null;
  const refuseWhileBusy = useCallback((): boolean => {
    if (!operationBusyReason) return false;
    toast.info(operationBusyReason);
    return true;
  }, [operationBusyReason]);

  /**
   * ═══⭐⭐⭐ THE VISUAL EDITOR ═══════════════════════════════════════════════
   *
   * Copied from totalum-platform whole — the hook, the inspector panel, the changes bar
   * and the two routes behind them (`/api/preview/*` re-serves the project same-origin so
   * the page can be scripted; `/api/visual-edit/[projectId]/apply` matches each change back
   * to the source file and writes it).
   *
   * ⚠️ IT ONLY WORKS AGAINST THE LIVE DEV SERVER. Everything it does — select an element,
   * read its computed styles, type into it — happens in a document the sandbox is
   * serving. On a sleeping project the frame is showing a STATIC ARCHIVE SNAPSHOT, and an
   * editor opened over that lets people retype headings that can never be applied: the
   * edits are computed against a copy of the app, and there is no server to write to. So
   * the toggle is refused until `liveReady` — see `visualEditBlockedReason`.
   */
  /**
   * ⚠️⚠️ ONE FRAME OWNS THIS REF, AND IT MUST BE THE VISIBLE ONE. This page renders the
   * desktop layout and the mobile layout at the same time and hides one with CSS, so BOTH
   * `<PreviewPanel>`s are mounted. Handing the ref to both makes the last one to mount win
   * — the hidden mobile frame — and then every message the editor posts goes to a document
   * nobody is looking at: the agent reports `ready` (so the panel looks connected) but
   * never receives `setActive`, and clicking the visible preview selects nothing. Only the
   * desktop instance gets `frameRef` and `proxiedSrc`; the visual editor is a desktop
   * feature here, exactly as its inspector column implies — which is also why only the
   * desktop `<ChatPanel>` gets the pencil.
   */
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [visualEditorOpen, setVisualEditorOpen] = useState(false);
  const visual = useVisualEditor({
    projectId,
    iframeRef: previewFrameRef,
    enabled: visualEditorOpen,
  });
  /** An apply outlives the panel: the frame must stay proxied until it settles. */
  const visualLocked = visual.phase === "applying" || visual.phase === "rebuilding";
  const blocked = useServerBlocked();

  const TABS = [
    { id: "preview", label: "Preview", icon: Eye },
    { id: "more", label: translate("more.tab"), icon: LayoutGrid },
    { id: "code", label: "Code", icon: Code2 },
  ];

  // The errands, for the mobile menu: each opens a modal rather than a tab.
  const MODAL_ENTRIES: { id: WorkspaceModal; label: string; icon: typeof Clock }[] = [
    { id: "versions", label: "Versions", icon: Clock },
  ];

  const [project, setProject] = useState<VcaasProject | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [activeTab, setActiveTab] = useState("preview");
  const [prompt, setPrompt] = useState("");
  /**
   * ⭐ THE COMPOSER'S ATTACHMENTS LIVE HERE, NOT IN `ChatPanel`, FOR TWO REASONS.
   * The mobile and desktop composers are BOTH mounted (one is hidden by CSS), so
   * panel-local state would give the two lists that drift apart — sending on one
   * would leave the chip on the other. And state on the page can be persisted, which
   * is what makes an attachment survive a reload; see `composer-attachments.ts`.
   *
   * ⚠️ THE PROJECT IS PART OF THE STATE, NOT JUST OF THE STORAGE KEY. This route
   * reuses the component when the id changes, so for one render the state still holds
   * the PREVIOUS project's files while `projectId` is already the new one. Tagging the
   * list with the project it belongs to is what stops that render from saving one
   * project's attachments under another's key, and from showing them for a moment.
   */
  const [attachments, setAttachments] = useState<{ projectId: string | null; files: AgentInputFile[] }>(
    { projectId: null, files: [] }
  );
  const attachedFiles = useMemo(
    () => (attachments.projectId === projectId ? attachments.files : EMPTY_ATTACHMENTS),
    [attachments, projectId]
  );
  const setAttachedFiles = useCallback((update: React.SetStateAction<AgentInputFile[]>) => {
    setAttachments((prev) => {
      const base = prev.projectId === projectId ? prev.files : EMPTY_ATTACHMENTS;
      return { projectId, files: typeof update === "function" ? update(base) : update };
    });
  }, [projectId]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewCached, setPreviewCached] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [resumingGeneration, setResumingGeneration] = useState(false);
  /** Bumped whenever an import or restore replaces the project's source. */
  const [sourceRevision, setSourceRevision] = useState(0);
  const [chatWidth, setChatWidth] = useState(440);
  const [isResizing, setIsResizing] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "panel">("panel");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [iframePath, setIframePath] = useState("/");
  const [darkMode, setDarkMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [diffSource, setDiffSource] = useState<DiffSource | null>(null);
  /**
   * ⭐ THE RUN PROGRESS BAR'S INPUTS, from `agent/status` — see `RunProgress`.
   * `expectedMinutes` is persisted per project so a reload resumes the bar on the
   * engine's estimate at once, instead of the generic ten minutes until the first poll.
   * (The start time needs no copy here: `useRunClock` keeps its own stamp.)
   */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [expectedMinutes, setExpectedMinutesState] = useState<number | null>(null);
  const expectedMinutesKey = `totalum:run-expected:${projectId}`;
  const setExpectedMinutes = useCallback((value: number | null) => {
    setExpectedMinutesState(value);
    try {
      if (value) localStorage.setItem(expectedMinutesKey, String(value));
      else localStorage.removeItem(expectedMinutesKey);
    } catch { /* storage unavailable — the next poll brings it back */ }
  }, [expectedMinutesKey]);
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(expectedMinutesKey));
      if (stored > 0) setExpectedMinutesState(stored);
    } catch { /* storage unavailable */ }
  }, [expectedMinutesKey]);

  const mountedRef = useRef(true);
  /** When the project was last read successfully — the "stale tab" effect's clock. */
  const lastProjectReadAt = useRef(Date.now());
  const sendingRef = useRef(false);
  const pendingAgentStartRequestRef = useRef<PendingAgentStartRequest | null>(null);
  const acceptedAgentStartFingerprintRef = useRef<string | null>(null);
  const autoSentRef = useRef<string | null>(null);
  // Guards the poll loop right after a new run is started: the server may still
  // report the PREVIOUS run's "done"/"idle" for a moment, and concluding on that
  // stale status would wipe the just-sent message and stop polling. We wait to
  // actually observe "init" before allowing a "done"/"idle" to conclude the run.
  const pendingRunRef = useRef(false);
  const runWaitPollsRef = useRef(0);
  // Attachments the user sent this session, in order. The conversation API
  // does not echo attachments back, so when fetchConversation() replaces the
  // message list we re-hydrate the chips/thumbnails onto matching user messages.
  const sentFilesRef = useRef<{ message: string; files: { name: string; url: string; imageDescription: string }[] }[]>([]);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One deploy/unpublish watcher, so two poll loops cannot race the same row. */
  const deployPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deployPollAttemptsRef = useRef(0);
  /**
   * A generation, not just a cleared timeout: `stopDeployPolling()` cannot abort a
   * fetch that is already in flight. Incrementing this makes that stale response
   * return without scheduling a second loop.
   */
  const deployPollGenerationRef = useRef(0);
  /**
   * Why the current watcher was started. A takedown that turns out to have been
   * reverted (`ready`) must not report "Published successfully!", and a failed
   * unpublish must not be described as a deployment failure.
   */
  const deployPollIntentRef = useRef<"publish" | "unpublish">("publish");
  /**
   * ⭐ THE SPLITTER'S LIVE DRAG STATE LIVES IN REFS, NOT REACT STATE. Writing the panel
   * width through `setState` on every `pointermove` re-rendered the entire workspace —
   * chat history, code editor and preview panel — for a value only the drag cares about.
   * The drag writes the width straight to the two DOM nodes that use it (once per frame)
   * and commits a single state update when the pointer is released.
   */
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const leftHeaderRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; currentWidth: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, []);

  // Global dark mode
  useEffect(() => {
    if (darkMode) { document.documentElement.classList.add("dark"); document.body.style.background = "#1a1a1a"; document.body.style.color = "#e5e5e5"; }
    else { document.documentElement.classList.remove("dark"); document.body.style.background = ""; document.body.style.color = ""; }
    return () => { document.documentElement.classList.remove("dark"); document.body.style.background = ""; document.body.style.color = ""; };
  }, [darkMode]);

  // Close menu on outside click or iframe blur
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check if click is inside the menu trigger OR the popup itself
      if (menuRef.current && menuRef.current.contains(target)) return;
      // Also check by data attribute on the popup
      const popup = document.querySelector("[data-popup-menu]");
      if (popup && popup.contains(target)) return;
      setMenuOpen(false);
    };
    const handleBlur = () => setMenuOpen(false);
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("blur", handleBlur);
    return () => { window.removeEventListener("mousedown", handleClick); window.removeEventListener("blur", handleBlur); };
  }, [menuOpen]);

  /**
   * The DOM write for a drag frame. No layout reads: the start width and the pointer's
   * start X were captured once on pointerdown, so every move is pure arithmetic.
   */
  const applyLiveChatWidth = useCallback((width: number) => {
    if (chatColumnRef.current) chatColumnRef.current.style.width = `${width}px`;
    if (leftHeaderRef.current) leftHeaderRef.current.style.width = `${width + CHAT_DIVIDER_WIDTH}px`;
  }, []);

  const finishResize = useCallback(() => {
    const drag = resizeRef.current;
    if (!drag) return;
    resizeRef.current = null;
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    // Flush the last pointer position even if it arrived after the last animation frame.
    applyLiveChatWidth(drag.currentWidth);
    setChatWidth(drag.currentWidth);
    setIsResizing(false);
  }, [applyLiveChatWidth]);

  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || resizeRef.current) return;
    e.preventDefault();
    resizeRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: chatWidth, currentWidth: chatWidth };
    /**
     * ⚠️ POINTER CAPTURE, SO THE DRAG OUTLIVES THE DIVIDER. Once captured, moves keep
     * arriving here even over the preview iframe and outside the window, and an implicit
     * release on pointerup/pointercancel ends the drag. `onLostPointerCapture` is the
     * fallback for a capture the browser takes away.
     */
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
  }, [chatWidth]);

  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.currentWidth = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, drag.startWidth + (e.clientX - drag.startX)));
    // Coalesce however many pointer events the browser fires into one DOM write per frame.
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const pending = resizeRef.current;
      if (pending) applyLiveChatWidth(pending.currentWidth);
    });
  }, [applyLiveChatWidth]);

  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    finishResize();
  }, [finishResize]);

  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = chatWidth - step;
    else if (e.key === "ArrowRight") next = chatWidth + step;
    else if (e.key === "Home") next = CHAT_MIN_WIDTH;
    else if (e.key === "End") next = CHAT_MAX_WIDTH;
    if (next === null) return;
    e.preventDefault();
    setChatWidth(Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, next)));
  }, [chatWidth]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
  }, []);

  async function fetchProject(
    options: { preservePreviewOnUnsuccessfulRun?: boolean } = {},
  ): Promise<VcaasProject | null> {
    const res = await vcaasApi.projects.get(projectId);
    if (res.ok && res.data && mountedRef.current) {
      lastProjectReadAt.current = Date.now();
      const nextPreviewUrl = getPreviewUrlFromProject(res.data);
      setProject(res.data);
      setPreviewUrl((current) => (
        options.preservePreviewOnUnsuccessfulRun &&
        (res.data.currentRun?.status !== "done" || !nextPreviewUrl)
          ? current
          : nextPreviewUrl
      ));
      setPreviewCached(isCachedPreview(res.data));
      return res.data;
    }
    return null;
  }
  async function fetchConversation(): Promise<void> {
    const res = await vcaasApi.agent.fullConversation(projectId);
    if (res.ok && res.data && mountedRef.current) setMessages(rehydrateAttachments(res.data.conversation || []));
  }
  /**
   * ═══⭐ THE ATTACHMENTS ON A PAST MESSAGE ════════════════════════════════════
   *
   * Two sources, and the session's own uploads win where both have something:
   *
   *  1. **What we sent this session** (`sentFilesRef`) — the exact URLs the upload
   *     endpoint returned, never round-tripped through the API, so never escaped.
   *  2. **What the API persisted** (`message.files`) — the only source that survives a
   *     reload, and the reason this function is no longer a no-op for a fresh tab.
   *
   * ⚠️ THE PERSISTED URL MUST BE ENTITY-DECODED OR IT 403s. See `ConversationMessage.files`.
   */
  function rehydrateAttachments(conversation: ConversationMessage[]): ConversationMessage[] {
    const pending = [...sentFilesRef.current];
    return conversation.map((m) => {
      if (m.author !== "user") return m;
      const idx = pending.findIndex((p) => p.message === m.message);
      if (idx !== -1) {
        const [match] = pending.splice(idx, 1);
        return { ...m, inputFiles: match.files };
      }
      const persisted = decodeAttachments(m.files);
      return persisted ? { ...m, inputFiles: persisted } : m;
    });
  }
  /**
   * ⭐ THE GITHUB CONNECTION STATE, FROM THE INTEGRATION THAT IMPLEMENTS IT.
   *
   * "Connected" means this PROJECT has a repository connected — an authorized
   * account on its own is not a connection, and the menu's green dot must not
   * claim otherwise.
   */
  async function fetchGithubStatus(): Promise<void> {
    const res = await githubApi.status(projectId);
    if (res.ok && res.data && mountedRef.current) setGithubConnected(!!res.data.connection);
  }
  function startAgentPolling() {
    stopAgentPolling();
    void completionSounds.observeWorkflow();
    pollAgentOnce();
  }
  function stopAgentPolling() { if (pollingRef.current) { clearTimeout(pollingRef.current); pollingRef.current = null; } }
  async function pollAgentOnce() {
    if (!mountedRef.current) return;
    const res = await vcaasApi.agent.status(projectId);
    if (!mountedRef.current) return;
    if (res.ok && res.data) {
      void completionSounds.observeWorkflow();
      const rt = res.data.realtimeConversation || [];
      if (rt.length > 0) {
        setMessages((prev) => {
          const agentMsgs = rt.filter((m) => m.author === "agent");
          const existingAgentKeys = new Set(prev.filter((m) => m.author === "agent").map((m) => `${m.createdAt}|${m.message?.slice(0, 60)}`));
          const newAgentMsgs = agentMsgs.filter((m) => !existingAgentKeys.has(`${m.createdAt}|${m.message?.slice(0, 60)}`));
          return newAgentMsgs.length > 0 ? [...prev, ...newAgentMsgs] : prev;
        });
      }
      // Once we actually observe the run running, clear the "just started" guard.
      if (res.data.status === "init") {
        pendingRunRef.current = false; runWaitPollsRef.current = 0;
        // The progress bar's inputs — only from a RUNNING status, never the previous run's.
        const started = res.data.startedAt ? Date.parse(res.data.startedAt) : NaN;
        setRunStartedAt(Number.isNaN(started) ? null : started);
        const expected = res.data.expectedMinutes;
        setExpectedMinutes(typeof expected === "number" && expected > 0 ? expected : null);
      }
      const terminal = res.data.status === "done" || res.data.status === "idle";
      // A run we just started may still show the previous run's terminal status.
      // Keep polling (fast) until we see "init", so we don't prematurely conclude
      // and wipe the freshly-sent user message via fetchConversation.
      if (terminal && pendingRunRef.current) {
        runWaitPollsRef.current += 1;
        if (runWaitPollsRef.current < 4) { pollingRef.current = setTimeout(pollAgentOnce, 3000); return; }
        pendingRunRef.current = false; // extremely fast/edge run — stop waiting and conclude
      }
      if (terminal) {
        setRunStartedAt(null); setExpectedMinutes(null);
        const proj = await fetchProject({ preservePreviewOnUnsuccessfulRun: true });
        await fetchConversation();
        if (
          proj?.currentRun?.status === "done" &&
          getPreviewUrlFromProject(proj) &&
          mountedRef.current
        ) {
          setPreviewKey((k) => k + 1);
        }
        return;
      }
    }
    pollingRef.current = setTimeout(pollAgentOnce, 10000);
  }
  /**
   * ⚠️ A PUBLISH TAKES THE DEV PREVIEW DOWN: the backend stops `npm start` for the
   * production build and restarts it at the end (success AND failure), so the frame was
   * left on a dead page until a browser refresh. Once the app answers, do what that did.
   */
  function reloadPreviewAfterPublish() {
    void waitForPreview(projectId).then(() => {
      if (!mountedRef.current) return;
      void fetchProject();
      setPreviewKey((k) => k + 1);
    });
  }
  async function pollDeployOnce(generation = deployPollGenerationRef.current) {
    if (!mountedRef.current || generation !== deployPollGenerationRef.current) return;
    deployPollAttemptsRef.current += 1;
    const res = await vcaasApi.deployments.status(projectId);
    if (!mountedRef.current || generation !== deployPollGenerationRef.current) return;

    /**
     * ⚠️ A PERMANENT REFUSAL ENDS THE WATCH IMMEDIATELY. Before this, a 503 fell
     * through to the bottom of this function and scheduled another attempt, so one
     * publish on a deployment without a provider produced up to 90 requests over
     * fifteen minutes and then said "refresh in a moment to see the current state".
     * There is no state to see: the provider is not configured.
     */
    if (isPublishingUnavailable(res)) {
      setPublishingUnavailable(true);
      setDeploying(false);
      setUnpublishing(false);
      operation.end("publish");
      toast.error("Publishing is not available on this deployment.", {
        description: "No deployment provider is configured, so there is no live site to watch.",
      });
      return;
    }

    if (res.ok && res.data) {
      const next = res.data;
      setDeploymentStatus(next);
      const status = next.status;

      if (status === "success") {
        setUnpublishing(false);
        setDeploying(false);
        operation.end("publish");
        reloadPreviewAfterPublish();
        if (deployPollIntentRef.current === "unpublish") {
          /**
           * The takedown did not happen and the previous deployment is still
           * serving. Say exactly that instead of reporting a successful publish.
           */
          toast.warning(translate("workspace.deploy.unpublishIncomplete"), {
            description: translate("workspace.deploy.unpublishIncompleteDescription"),
          });
          void fetchProject();
          return;
        }
        toast.success("Published successfully!");
        const proj = await fetchProject();
        if (!mountedRef.current || generation !== deployPollGenerationRef.current) return;
        /**
         * ⭐ THE ONE OPERATION THAT EARNS A DIALOG. The whole point of publishing is the
         * ADDRESS — to click, to copy, to send to somebody — and a toast that disappears
         * in four seconds is the wrong place for it. The same dialog owns "Publish the
         * latest changes" and "Unpublish website" afterwards.
         */
        setPublishDialogOpen(true);
        // Surface the deploy result in the chat and pull the latest conversation.
        const liveUrl = getPublishedHost(proj ?? project, projectId);
        setMessages((prev) => [...prev, {
          author: "agent",
          message: `${"🚀 Your app is now live at"} https://${liveUrl}`,
          messageType: "finished",
          createdAt: new Date().toISOString(),
        }]);
        fetchConversation();
        return;
      }

      if (status === "error") {
        setUnpublishing(false);
        setDeploying(false);
        operation.end("publish");
        reloadPreviewAfterPublish();
        // New engine: why it failed is on the status (and on the project's `lastDeployError`, which the banner shows).
        if (deployPollIntentRef.current === "unpublish") {
          // The upstream wording describes a build; a takedown failure needs its
          // own copy so the user knows the public site may still be serving.
          toast.error(translate("workspace.deploy.unpublishFailed"), {
            description: translate("workspace.deploy.unpublishIncompleteDescription"),
          });
        } else {
          toast.error(next.errorDetails?.title || "Deployment failed");
        }
        void fetchProject();
        return;
      }

      /**
       * A recorded unpublish is terminal. Refresh the project so the workspace stops
       * presenting the mapping as a live deployment; there is deliberately no success
       * toast here — the action that requested it already reported the outcome.
       */
      if (status === "unpublished") {
        setUnpublishing(false);
        setDeploying(false);
        void fetchProject();
        return;
      }

      if (status === "unpublishing") {
        // An `unpublishing` row can only come from a takedown, never a publish.
        deployPollIntentRef.current = "unpublish";
        setDeploying(false);
        setUnpublishing(true);
      }
      if (status === "deploying") {
        setUnpublishing(false);
        setDeploying(true);
      }
      if (status !== "deploying" && status !== "unpublishing") return;
    }

    if (deployPollAttemptsRef.current >= DEPLOY_POLL_MAX_ATTEMPTS) {
      /**
       * ⚠️ KEEP THE LAST OBSERVED STATE. Resetting the local flags while the backend
       * may still report `deploying`/`unpublishing` would re-enable a button whose
       * outcome is unknown. The toast tells the user how to get the truth.
       */
      operation.end("publish");
      toast.warning("We stopped watching this — refresh in a moment to see the current state.");
      return;
    }
    deployPollRef.current = setTimeout(
      () => void pollDeployOnce(generation),
      DEPLOY_POLL_INTERVAL_MS,
    );
  }
  /** One watcher at a time: a second publish/unpublish must not leave two loops. */
  function startDeployPolling(intent: "publish" | "unpublish" = "publish") {
    stopDeployPolling();
    deployPollIntentRef.current = intent;
    const generation = deployPollGenerationRef.current;
    deployPollAttemptsRef.current = 0;
    void pollDeployOnce(generation);
  }
  function stopDeployPolling() {
    deployPollGenerationRef.current += 1;
    if (deployPollRef.current) {
      clearTimeout(deployPollRef.current);
      deployPollRef.current = null;
    }
  }
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      const [proj] = await Promise.all([fetchProject(), fetchConversation(), fetchGithubStatus()]);
      if (cancelled) return;
      setLoading(false);
      if (proj?.agentProcessStatus === "init") startAgentPolling();

      /**
       * ⭐ THE PUBLISH STATE COMES FROM THE BACKEND, NOT FROM `project.deployment`.
       * The project document only says `deploying|success|error`; the status endpoint
       * also knows `unpublishing|unpublished` and is the only source that may claim a
       * site is still live. A failed read falls back to the project document so a
       * publish that is genuinely in flight is still watched.
       */
      const deployment = await vcaasApi.deployments.status(projectId);
      if (cancelled) return;
      if (deployment.ok && deployment.data) {
        setDeploymentStatus(deployment.data);
        const status = deployment.data.status;
        if (status === "deploying") {
          setDeploying(true);
          startDeployPolling("publish");
        } else if (status === "unpublishing") {
          setUnpublishing(true);
          startDeployPolling("unpublish");
        } else {
          setDeploying(false);
          setUnpublishing(false);
        }
      } else if (isPublishingUnavailable(deployment)) {
        /**
         * ⚠️ NOT A TRANSIENT FAILURE, SO NO FALLBACK POLL. This deployment has no
         * deployment provider; the project document's `deploying` flag (if any) is a
         * leftover row, and watching it would poll a permanent 503 for fifteen minutes.
         */
        setPublishingUnavailable(true);
        setDeploying(false);
        setUnpublishing(false);
      } else if (proj?.deployment?.status === "deploying") {
        setDeploying(true);
        startDeployPolling();
      }

      /**
       * Adopt a durable import lock when a backend supplies one. The local operation
       * stamp still paints immediately after navigation; the current Mavly response
       * leaves `importInProgress` null, so the watcher also checks static readiness.
       */
      if (proj?.importInProgress) {
        operation.adopt("import", Date.parse(proj.importInProgress.startedAt) || undefined);
      }
    }
    init(); return () => { cancelled = true; stopAgentPolling(); stopDeployPolling(); };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ⚠️ FIGMA'S STATUS IS READ ON MOUNT, NOT WHEN THE MODAL OPENS. `FigmaModal` only
   * loads while `open`, so without this the composer's Figma button read "not connected"
   * on every fresh workspace until someone happened to open the dialog. No `verify`: that
   * spends a live call against Figma's API to answer a question a tint does not ask.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await vcaasApi.figma.status(projectId);
      if (active && response.ok && response.data) setFigmaConnected(!!response.data.connected);
    })();
    return () => { active = false; };
  }, [projectId]);

  /**
   * ⭐ DISCONNECT FIGMA FROM THE COMPOSER, without opening the modal. It RETHROWS on
   * failure: `FigmaPromptButton` awaits this and keeps its popover open — still showing
   * "connected" — when it rejects, instead of closing on a disconnect that did not happen.
   */
  const handleDisconnectFigma = useCallback(async () => {
    const response = await vcaasApi.figma.disconnect(projectId);
    if (!response.ok) {
      toast.error(translate("workspace.figma.disconnectFailed"), { description: response.error || undefined });
      throw new Error(response.error || "figma disconnect failed");
    }
    setFigmaConnected(false);
    toast.success(translate("workspace.figma.disconnected"));
  }, [projectId]);

  // Core send routine — accepts an explicit prompt text so it can be driven both
  // by the chat input and by the auto-submit flow (a project just created from the
  // dashboard whose first prompt is carried over via sessionStorage).
  const sendPromptText = useCallback(async (text: string, files?: { name: string; url: string; imageDescription: string }[], options?: AgentRunOptions) => {
    if ((!text.trim() && (!files || files.length === 0)) || sendingRef.current) return;
    const runOptions = optionsForEngine(options || {}, isV2Project(project));
    const requestPayload = { prompt: text, inputFiles: files || [], ...runOptions };
    let fingerprint: string;
    try {
      fingerprint = await agentStartRequestFingerprint(requestPayload);
    } catch (error) {
      console.error("[workspace] Could not prepare an idempotent agent request.", error);
      toast.error("Could not safely prepare this request. Please try again.");
      return;
    }

    let pendingStart = pendingAgentStartRequestRef.current;
    if (pendingStart?.fingerprint !== fingerprint) {
      pendingStart = null;
    }
    if (!pendingStart && acceptedAgentStartFingerprintRef.current !== fingerprint) {
      try {
        const stored = sessionStorage.getItem(agentStartRequestStorageKey(projectId));
        if (stored) {
          const parsed = pendingAgentStartRequest(JSON.parse(stored));
          pendingStart =
            parsed && !parsed.accepted && parsed.fingerprint === fingerprint
              ? parsed
              : null;
        }
      } catch {
        pendingStart = null;
      }
    }
    if (!pendingStart) {
      pendingStart = { fingerprint, clientRequestId: crypto.randomUUID() };
    }
    pendingAgentStartRequestRef.current = pendingStart;
    try {
      sessionStorage.setItem(
        agentStartRequestStorageKey(projectId),
        JSON.stringify(pendingStart),
      );
    } catch {
      // The in-memory key still protects retries for this mounted workspace.
    }

    sendingRef.current = true;
    setSending(true);
    const hasFiles = !!files && files.length > 0;
    if (hasFiles) sentFilesRef.current.push({ message: text, files: files! });
    setMessages((prev) => [...prev, { author: "user", message: text, messageType: "regular", createdAt: new Date().toISOString(), inputFiles: hasFiles ? files : undefined }]);
    setPrompt("");
    /**
     * ⚠️ ONLY WHAT THE USER CHOSE IS SENT. `options` is `{}` unless the run-options menu
     * was touched, so Totalum's own model/effort routing stays in charge by default.
     */
    const res = await vcaasApi.agent.start(projectId, {
      ...requestPayload,
      clientRequestId: pendingStart.clientRequestId,
    });
    if (res.ok) {
      pendingAgentStartRequestRef.current = null;
      acceptedAgentStartFingerprintRef.current = fingerprint;
      try {
        sessionStorage.setItem(
          agentStartRequestStorageKey(projectId),
          JSON.stringify({ ...pendingStart, accepted: true }),
        );
        sessionStorage.removeItem(agentStartRequestStorageKey(projectId));
      } catch {
        // A stale stored key is ignored when the next request fingerprint differs.
      }
      setProject((prev) => prev ? { ...prev, agentProcessStatus: "init" } : prev);
      pendingRunRef.current = true; runWaitPollsRef.current = 0;
      // A new run: the previous run's estimate must not show while the first poll is out.
      setRunStartedAt(null); setExpectedMinutes(null);
      startAgentPolling();
    } else {
      /**
       * ═══⭐⭐ A REFUSED PROMPT PUTS EVERYTHING BACK ═══════════════════════════
       *
       * ⚠️ THE OPTIMISTIC MESSAGE MUST GO. Leaving it would show the agent an
       * instruction it never received — the user would sit watching for a reply to a
       * prompt that was never accepted.
       *
       * ⚠️ AND THE PROMPT ITSELF COMES BACK TO THE BOX, with its attachments. The
       * answer to a sleeping server is "press send again in a minute", which is
       * impossible if sending emptied the composer.
       */
      setMessages((prev) => prev.slice(0, -1));
      if (hasFiles) sentFilesRef.current.pop();
      setPrompt(text);
      if (hasFiles) setAttachedFiles(files!);

      /**
       * ⭐⭐ THE SERVER WAS ASLEEP, SO THE API STARTED IT AND REFUSED THE PROMPT.
       * That is not a failure and must not read as one: `claim` turns the refusal into
       * the wake strip with its clock, and tells the user the moment they can send.
       * Publish, pull and restore already did this; the composer was the one action
       * still answering a sleeping server with a red error.
       */
      if (serverWake.claim(res, () => toast.success(translate("workspace.serverWake.readyFor", { action: translate("workspace.serverWake.actionSendPrompt") })))) {
        setSending(false);
        sendingRef.current = false;
        return;
      }

      toast.error(res.error || "Failed to start agent");
    }
    setSending(false);
    sendingRef.current = false;
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSendPrompt = async (files?: { name: string; url: string; imageDescription: string }[], options?: AgentRunOptions) => {
    if (project?.agentProcessStatus === "init") return;
    await sendPromptText(prompt, files, options);
  };

  /**
   * ═══⭐⭐ THE AUTOMATIC START ITSELF ═══════════════════════════════════════
   *
   * Every guard below rules the start out from a different angle, and all of them have
   * to agree. This mirrors totalum-platform's effect in `WorkspaceShell`.
   *
   * ⚠️ `Archived` ONLY. Not `Archiving` (on its way down, startable in a moment), not
   * the in-transition states (already coming up), and NOT a missing `agentServerStatus`
   * — an absent field is far more likely to be a partial read than a dead VM, and
   * spending credits on that guess, unprompted, is the wrong way to be wrong. A
   * genuinely dead sandbox still self-heals on the first real action the user takes.
   *
   * ⚠️ NOT WHILE ANYTHING ELSE OWNS THE SANDBOX. A project created moments ago has no
   * sandbox yet and its first prompt is already creating one; firing a second start
   * into that is wasted at best.
   *
   * ⚠️ ONCE PER PROJECT PER MOUNT, via the ref. A reload can still fire it again, and
   * that is free: the API refuses without charging while a sandbox is `Unarchiving`,
   * and `claim` renders that refusal as the same wait strip.
   */
  const autoStartedFor = useRef<string | null>(null);

  useEffect(() => {
    if (loading || !project) return;
    if (autoStartedFor.current === projectId) return;

    // ⚠️ Nothing starts until the user engages with the project — see the latch above.
    if (!touchedProject) return;

    // Anything already in motion owns the sandbox; do not touch it.
    // (`isBuilding` is exactly this status check, and is declared further down.)
    if (operation.kind || project.agentProcessStatus === "init") return;

    // A wake is already in flight; a second start would cost a credit for nothing.
    if (serverWake.waking) return;

    /**
     * ⚠️⚠️ `Archived` OR NO SERVER AT ALL. Production answers a sleeping project with NO
     * `agentServerStatus` (checked 2026-09-14), so requiring exactly `Archived` meant a
     * click never started anything and the wake strip never appeared. A missing status
     * counts only when upstream ALSO recommends the archive snapshot — its own statement
     * that no live server exists — so a partial read still starts nothing.
     */
    if (!hasNoLiveServer(project)) return;

    // ⚠️ PROOF THE PROJECT HAS EVER BEEN BUILT. A conversation with no user message has
    // never had a prompt run against it, so there is nothing archived worth restoring.
    if (!messages.some((message) => message.author === "user")) return;

    autoStartedFor.current = projectId;

    void (async () => {
      const res = await vcaasApi.agent.restartServer(projectId);
      if (!mountedRef.current) return;

      /**
       * ⚠️ THE SUCCESS PATH IS THE ONE THAT NEEDS THE STRIP. `start-or-restart` answers
       * a 200, so `claim` — which only recognises `SERVER_NOT_READY` — would never see
       * it. Enter the wait directly, with no retry callback: nothing was refused, so
       * there is nothing to redo. When it is up, show the live app instead of the
       * snapshot the frame has been serving.
       */
      if (res.ok) {
        serverWake.begin(() => { void fetchProject(); setPreviewKey((k) => k + 1); });
        return;
      }

      // Somebody else got there first, or it is already starting: same strip, silently.
      // ⚠️ `silent` — THE USER PRESSED NOTHING, so the dialog that answers a refused
      // button press would here be thrown at somebody who has just arrived.
      if (serverWake.claim(res, undefined, { silent: true })) return;

      /**
       * ⚠️ A REAL FAILURE IS SWALLOWED, DELIBERATELY. They asked to open their project,
       * not to start a server. A red toast about a start they never requested is noise,
       * and every action they might take next starts it again and reports properly.
       */
      console.warn("[workspace] auto server start refused:", res.code || res.error);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, project, projectId, touchedProject, operation.kind, messages, serverWake]);

  /**
   * ═══⭐⭐ THE STALE TAB — RE-READ THE PROJECT WHEN THE USER COMES BACK ═══════════════
   *
   * A tab left open for hours outlives its server: the hourly archive job puts it to sleep
   * and nothing re-reads the project, so the preview kept its dead live url and showed
   * Cloudflare's "not available" page until a manual refresh. When the user returns (tab
   * visible, window focus, a click — `blur` catches a click INTO the preview frame) and the
   * last read is older than `STALE_PROJECT_MS`, re-read it: `fetchProject` recomputes the
   * preview url, so a snapshot recommendation swaps the frame by itself.
   *
   * ⚠️ WHEN THE SERVER TURNS OUT TO BE GONE, the touch latch and `autoStartedFor` are
   * re-armed: only a click on the project (not the header) may start the server — tabbing
   * back must not spend credits — and a wake earlier in this load must not block the next.
   */
  useEffect(() => {
    if (loading) return;
    let inFlight = false;

    const recheck = async (event?: Event) => {
      if (inFlight || document.hidden) return;
      if (Date.now() - lastProjectReadAt.current < STALE_PROJECT_MS) return;
      if (operation.kind || project?.agentProcessStatus === "init") return;

      inFlight = true;
      const hadLiveServer = !!project && !hasNoLiveServer(project);
      const detail = await fetchProject();
      inFlight = false;
      if (!mountedRef.current || !detail) return;
      if (!hadLiveServer || !hasNoLiveServer(detail)) return;

      const target = event?.type === "pointerdown" ? (event.target as HTMLElement | null) : null;
      const touched = !!target && !target.closest?.("[data-workspace-header]");
      workspaceTouched.current = touched;
      setTouchedProject(touched);
      autoStartedFor.current = null;
    };

    const onVisibility = () => void recheck();
    const onWindowEvent = (event: Event) => void recheck(event);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onWindowEvent);
    window.addEventListener("blur", onWindowEvent);
    window.addEventListener("pointerdown", onWindowEvent, true);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWindowEvent);
      window.removeEventListener("blur", onWindowEvent);
      window.removeEventListener("pointerdown", onWindowEvent, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, project, operation.kind]);

  /**
   * ⭐ ATTACHMENTS SURVIVE A RELOAD. Read on arrival, written on every change. Both
   * effects are no-ops until the state is tagged with THIS project, which is what keeps
   * the first render after a project switch from writing the previous one's list.
   */
  useEffect(() => {
    setAttachments({ projectId, files: loadAttachments(projectId) });
  }, [projectId]);

  useEffect(() => {
    if (attachments.projectId !== projectId) return;
    saveAttachments(projectId, attachments.files);
  }, [projectId, attachments]);

  // Auto-submit the first prompt when arriving from the dashboard "Build" flow.
  // The dashboard stashes the prompt (and any files) in sessionStorage keyed by
  // projectId; once the project is loaded and idle, we send it automatically so
  // the agent starts building right away.
  useEffect(() => {
    if (loading || !project || project.projectId !== projectId || autoSentRef.current === projectId) return;
    if (project.projectType === "android") {
      autoSentRef.current = projectId;
      try {
        sessionStorage.removeItem(`vibebuild:pendingPrompt:${projectId}`);
        sessionStorage.removeItem(`vibebuild:pendingFiles:${projectId}`);
      } catch {
        // A stale website handoff must never start generation for an Android project.
      }
      return;
    }
    if (project.agentProcessStatus === "init") return;
    const promptKey = `vibebuild:pendingPrompt:${projectId}`;
    const pending = typeof window !== "undefined" ? sessionStorage.getItem(promptKey) : null;
    if (!pending) return;
    autoSentRef.current = projectId;
    sessionStorage.removeItem(promptKey);
    const filesKey = `vibebuild:pendingFiles:${projectId}`;
    let files: { name: string; url: string; imageDescription: string }[] | undefined;
    try {
      const raw = sessionStorage.getItem(filesKey);
      if (raw) files = JSON.parse(raw);
    } catch { /* ignore */ }
    sessionStorage.removeItem(filesKey);
    sendPromptText(pending, files);
  }, [loading, project, projectId, sendPromptText]);
  /**
   * ═══⭐⭐⭐ THE ONE PLACE A LONG OPERATION FINISHES ═════════════════════════
   *
   * ⚠️ EVERY ONE OF THESE ENDS SOMEWHERE ELSE THAN IT STARTED — a restart finishes when
   * the sandbox says `Active`, a pull when GitHub's sync reports done, a restore when the
   * project stops reporting a recovery. Watching them in the component that fired the
   * request would mean the watch dies whenever that panel unmounts, which is precisely
   * what people do while they wait — and now that GitHub and versions are DIALOGS, it is
   * what closing one does. One watcher on the page, keyed on the slot, survives modal
   * closes, tab switches and (because the record is persisted) page reloads.
   *
   * ⚠️ IT IS BOUNDED. A job that stops reporting must not leave the banner up for the rest
   * of the session, so the watch gives up after `MAX_WATCH_ATTEMPTS` and says it stopped
   * watching rather than claiming a failure it did not observe.
   *
   * ⚠️ `publish` IS NOT HERE — the deploy poll below owns it, and two watchers on one job
   * is how a banner gets cleared while the work is still running.
   */
  useEffect(() => {
    const kind = operation.kind;
    if (!kind || kind === "publish") return;

    const MAX_WATCH_ATTEMPTS = 60; // 60 × 8s = 8 minutes
    let cancelled = false;
    let attempts = 0;
    let idleSeen = 0;
    /** Import only: whether the server-side lock was observed at least once. */
    let sawImporting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * ⚠️ A 200 IS NOT ENOUGH. While the server is down the sandbox serves its own
     * "preview building, expired or broken" page with a perfectly good status code.
     * `looksLikePlaceholder` is the platform's check, copied, so there is one definition
     * of "that is not your app".
     */
    const appIsServing = async (): Promise<boolean> => {
      try {
        const response = await fetch(`/api/preview/${encodeURIComponent(projectId)}/`, { cache: "no-store" });
        if (!response.ok) return false;
        return !looksLikePlaceholder(await response.text());
      } catch {
        return false; // indistinguishable from "not up yet"
      }
    };

    const finish = (message?: string) => {
      operation.end(kind);
      if (message) toast.success(message);
      fetchProject();
      setPreviewKey((k) => k + 1);
    };

    const tick = async () => {
      if (cancelled) return;
      attempts += 1;

      if (kind === "restartServer") {
        const detail = await vcaasApi.projects.get(projectId);
        if (cancelled) return;
        if (detail.ok && detail.data?.agentServerStatus === "Active") return finish("Your server is back");
      }

      /** Imports settle on their server lock or on a genuinely served static preview. */
      if (kind === "import") {
        const detail = await vcaasApi.projects.get(projectId);
        if (cancelled) return;
        if (detail.ok && detail.data) {
          const importInProgress = !!detail.data.importInProgress;
          if (importInProgress) sawImporting = true;
          else idleSeen += 1;

          const verdict = importWatchVerdict({
            importInProgress,
            importWasObserved: sawImporting,
            idlePolls: idleSeen,
            previewReady: detail.data.previewState?.status === "ready",
          });
          if (
            verdict === "completed" ||
            (verdict === "preview-ready" && (await appIsServing()))
          ) {
            if (cancelled) return;
            return finish(translate("workspace.operation.import.succeeded"));
          }
        }
      }

      if (kind === "restoreVersion") {
        const detail = await vcaasApi.projects.get(projectId);
        if (cancelled) return;
        // `versionRecovery` is present only while one is running; `error` is terminal too.
        const recovery = detail.data?.versionRecovery;
        if (detail.ok && (!recovery || recovery.status === "error")) {
          return finish(recovery?.status === "error" ? undefined : "Version restored");
        }
      }

      if (attempts >= MAX_WATCH_ATTEMPTS) {
        operation.end(kind);
        toast.warning("We stopped watching this — it may still be finishing. Refresh in a moment.");
        return;
      }
      timer = setTimeout(tick, 8000);
    };

    timer = setTimeout(tick, 8000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [operation.kind, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ⭐ IS THE PREVIEW ACTUALLY THERE? The visual editor scripts the same-origin
   * preview DOCUMENT, not a development server. What it needs is a current,
   * served preview entry — not `agentServerStatus === "Active"`, which no longer
   * exists because Mavly never runs a generated dev server. Payloads that do not
   * carry `previewState` keep their previous behaviour.
   *
   * ⚠️ THE LEGACY URL HALF IS UNCHANGED. It still requires the project to
   * recommend the live URL field, so a payload without that field stays
   * blocked exactly as before; this change removes the removed-status lie, it
   * does not newly enable the visual editor.
   */
  const liveReady =
    (project?.previewState
      ? project.previewState.status === "ready" || project.previewState.status === "stale"
      : true) &&
    getPreviewUrlField(project) === "temporalDevelopmentProjectUrl" &&
    !!project?.temporalDevelopmentProjectUrl;

  /**
   * ⚠️ NOTHING MAY BE EDITED VISUALLY WHILE THE PROJECT IS CHANGING UNDER IT. A prompt, a
   * publish, a pull and a restore all rewrite the files or the running server,
   * and the editor is a live document editor pointed at that server: opening it during one
   * means selecting elements in a page that is about to be replaced, then applying edits
   * computed against source that no longer exists.
   *
   * ⚠️ IT BLOCKS ENTERING, NEVER LEAVING — trapping someone inside the panel is worse than
   * the conflict this prevents.
   */
  const visualEditBlockedReason: "busy" | "starting" | null =
    project?.agentProcessStatus === "init" || operation.kind !== null
    ? "busy"
    : !liveReady
      ? "starting"
      : null;

  /**
   * ⭐⭐ THE PENCIL — refused, with the reason, rather than opened over a document it
   * cannot edit; see `visualEditBlockedReason`. Lives in the composer's tool tray now (the
   * platform's placement), so this is the one handler the tray calls.
   */
  const handleToggleVisualEdit = useCallback(() => {
    if (visualEditorOpen) { setVisualEditorOpen(false); return; }
    if (visualEditBlockedReason === "busy") {
      toast.info("Your project is changing right now — try again when it settles.");
      return;
    }
    if (visualEditBlockedReason === "starting") {
      blocked.show("starting");
      return;
    }
    setActiveTab("preview");
    setVisualEditorOpen(true);
  }, [visualEditorOpen, visualEditBlockedReason, blocked]);

  /**
   * ⭐⭐ APPLY — and the reason it is here rather than in the bar: closing the inspector
   * is part of applying (the page may change underneath it), while the FRAME
   * must stay proxied until the phase settles, or the user's preview-only edits vanish
   * from the screen for the whole apply.
   */
  const handleVisualApply = useCallback(() => {
    setVisualEditorOpen(false);
    void visual.apply();
  }, [visual]);

  const handleStopAgent = async () => { await vcaasApi.agent.stop(projectId); toast.info("Stop signal sent"); };
  /**
   * Manual recovery for a failed/interrupted run. This is the existing
   * checkpoint-safe endpoint: it reopens the SAME run, re-checks ownership and
   * admission limits, and the agent skips only verified completed paths. It is
   * separate from the bounded inline continuation, which already ran before the
   * workspace could show a failure.
   */
  const handleResumeGeneration = async () => {
    if (resumingGeneration) return;
    setResumingGeneration(true);
    try {
      const res = await vcaasApi.agent.resume(projectId);
      if (res.ok) {
        toast.success("Resuming generation");
        await fetchProject();
        setPreviewKey((k) => k + 1);
      } else {
        toast.error(res.error || "Could not resume generation");
      }
    } catch {
      toast.error("Could not resume generation");
    } finally {
      setResumingGeneration(false);
    }
  };
  // Autofill the chat prompt with an edit instruction for the given file, then focus the chat.
  const handleAskAiEdit = useCallback((path: string) => {
    setPrompt(`On file ${path} write what you want to edit`);
    setChatCollapsed(false);
    setMobileTab("chat");
    // Focus the chat textarea so the user can immediately continue typing.
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>("[data-chat-input]");
      if (el) { el.focus(); const len = el.value.length; el.setSelectionRange(len, len); }
    }, 60);
  }, []);
  /** `confirmDestructive`: the user confirmed the pending migration that deletes data (new engine; from the banner). */
  const handleDeploy = async (options: boolean | { approvalId?: string } = false) => {
    if (deploying || unpublishing) return;
    if (refuseWhileBusy()) return;
    /**
     * ⚠️ DON'T ASK A ROUTE THAT ALREADY SAID NO. When the status read above reported
     * `BACKEND_NOT_CONFIGURED`, the deploy route answers the same permanent 503 —
     * sending it only produces another failed request. Nothing is claimed either way:
     * "no provider is configured" is the whole truth.
     */
    if (publishingUnavailable) {
      toast.error("Publishing is not available on this deployment.", {
        description: "No deployment provider is configured, so this project cannot be published from Mavly.",
      });
      return;
    }
    setDeploying(true);
    const res = await vcaasApi.deployments.deploy(
      projectId,
      typeof options === "boolean"
        ? options
          ? { confirmDestructive: true }
          : {}
        : options,
    );

    /**
     * ⭐ THE SERVER WAS ASLEEP, SO THE API STARTED IT AND REFUSED THE PUBLISH. Not a
     * failure: the strip shows the wait and the dialog explains it. `claim` also tells
     * the user when it is ready — it deliberately does NOT publish for them, because an
     * action that fires minutes later, unattended, is one nobody consented to at the
     * moment it happened.
     */
    if (serverWake.claim(res, () => toast.success(translate("workspace.serverWake.readyFor", { action: translate("workspace.serverWake.actionPublish") })))) {
      setDeploying(false);
      return;
    }

    /**
     * ⭐ THE APP ITSELF IS NOT SERVING A PAGE, so upstream refuses to ship it — publishing
     * would put that broken page online. The two halves of `SANDBOX_NOT_REACHABLE` need
     * opposite advice, and totalum-backend says which one it saw.
     */
    if (res.upstreamCode === "SANDBOX_NOT_REACHABLE") {
      blocked.show(res.details?.reason === "app_error" ? "appError" : "starting");
      setDeploying(false);
      return;
    }

    if (res.ok) {
      toast.success("Deploying… this takes ~3 minutes");
      setUnpublishing(false);
      operation.begin("publish");
      startDeployPolling("publish");
    }
    else if (String(res.code ?? "") === "DEPLOYMENT_APPROVAL_REQUIRED") {
      toast.error("Approval required", {
        description: "Create a deployment proposal in More → Agents & approvals, approve it, then deploy that approval.",
      });
      setDeploying(false);
    }
    else if (isPublishingUnavailable(res)) {
      /**
       * ⚠️ THE DEPLOY ROUTE AGREES WITH THE STATUS ROUTE. Record it so the next press
       * refuses locally instead of sending the same permanently-refused request.
       */
      setPublishingUnavailable(true);
      setDeploying(false);
      toast.error("Publishing is not available on this deployment.", {
        description: res.error || "No deployment provider is configured.",
      });
    }
    else { toast.error(res.error || "Failed to deploy"); setDeploying(false); }
  };
  /**
   * Agents & approvals: deploy exactly the approved proposal. The id alone grants
   * nothing — the server re-derives the source, checks the approval and consumes
   * it atomically, so a stale or reused approval is refused.
   */
  const handleDeployWithApproval = async (approvalId: string) => {
    await handleDeploy({ approvalId });
  };
  /**
   * ═══ UNPUBLISH — THE REAL TAKEDOWN, NOT A HIDDEN URL ═══════════════════════
   *
   * The page never decides that a site is down. It sends the request, then trusts
   * only the state the backend returns: `unpublished` means Vercel confirmed the
   * public host is gone; `unpublishing` means another request owns the claim and
   * this page watches it. Anything else is a failure and is rethrown so
   * `ConfirmDialog` stays open with the backend's reason instead of closing as if
   * the takedown had worked.
   *
   * ⚠️ NO `serverWake`: unpublishing does not touch the development sandbox.
   */
  const handleUnpublish = async () => {
    if (unpublishing) throw new Error("An unpublish is already in progress.");
    setUnpublishing(true);
    stopDeployPolling();
    try {
      const res = await vcaasApi.deployments.unpublish(projectId);
      if (!res.ok || !res.data) {
        throw new Error(res.error || translate("workspace.deploy.unpublishFailed"));
      }
      setDeploymentStatus(res.data);
      if (res.data.status === "unpublishing") {
        startDeployPolling("unpublish");
        return;
      }
      if (res.data.status !== "unpublished") {
        throw new Error("The hosting provider did not confirm the unpublish.");
      }
      setUnpublishing(false);
      await fetchProject();
      toast.success(translate("workspace.deploy.unpublished"), {
        description: translate("workspace.deploy.unpublishedDescription"),
      });
    } catch (error) {
      /**
       * ⚠️ A FAILED UNPUBLISH ROLLS THE ROW BACK SERVER-SIDE. Re-read it before
       * answering: leaving the local state on `unpublishing` would strand the button
       * on "Unpublishing…" after the backend already released the claim.
       */
      const latest = await vcaasApi.deployments.status(projectId);
      if (mountedRef.current && latest.ok && latest.data) {
        setDeploymentStatus(latest.data);
        const latestStatus = latest.data.status;
        setUnpublishing(latestStatus === "unpublishing");
        if (latestStatus === "unpublishing") startDeployPolling("unpublish");
        /**
         * A concurrent tab may have completed the same takedown while this
         * request reported an error. The backend state is authoritative, so
         * report the confirmed outcome instead of a false failure.
         */
        if (latestStatus === "unpublished") {
          await fetchProject();
          toast.success(translate("workspace.deploy.unpublished"), {
            description: translate("workspace.deploy.unpublishedDescription"),
          });
          return;
        }
      } else {
        setUnpublishing(false);
      }
      toast.error(translate("workspace.deploy.unpublishFailed"), {
        description: error instanceof Error ? error.message : undefined,
      });
      throw error;
    }
  };
  const handleRestartServer = async () => {
    const res = await vcaasApi.agent.restartServer(projectId);
    if (res.ok) {
      toast.success("Server restarting...");
      /**
       * ⚠️ THE WORK HAS NOT FINISHED — it has barely started. `begin` only RECORDS the
       * operation; the banner's clock and its estimate come from the profile, and the
       * record is persisted so a reload mid-restart still shows it.
       */
      operation.begin("restartServer");
    }
    else toast.error(res.error || "Failed");
  };

  /**
   * ⭐ THE GITHUB DIALOG OWNS THE IMPORT.
   *
   * The old flow pushed a "pull" to the removed backend and watched an
   * operation slot for minutes. The import that replaced it is a short,
   * confirmed action: the dialog shows what the branch would change, the
   * project's source is saved as a recovery point, and the files are written.
   * There is no long operation to watch, so there is no banner to raise.
   */

  /**
   * ⭐ RESTORE A PAST VERSION — the versions modal's confirmation.
   *
   * ⚠️ IT THROWS ON FAILURE. `ConfirmDialog` keeps itself open and honest that way;
   * swallowing the error would close the dialog as if the restore had been accepted.
   *
   * ⚠️⚠️ AND IT NEVER REPLAYS ITSELF after a wake: a restore overwrites the project's
   * files, and the dialog that authorised it closed minutes ago. The wake tells the user
   * when they can press it again; pressing it stays their decision.
   */
  const handleRestoreVersion = useCallback(async (version: ProjectVersion) => {
    if (refuseWhileBusy()) return;
    const res = await vcaasApi.versions.recover(projectId, version._id);

    if (serverWake.claim(res, () => toast.success(translate("workspace.serverWake.readyFor", { action: translate("workspace.serverWake.actionRestore") })))) {
      toast.info(translate("workspace.serverWake.title"), { description: translate("workspace.serverWake.bodyRetry") });
      throw new Error(res.code || "server not ready");
    }
    if (!res.ok) {
      toast.error(translate("workspace.versions.restoreFailed"), { description: res.error || undefined });
      throw new Error(res.error || "restore failed");
    }
    toast.success(translate("workspace.versions.restoreStarted", { name: version.name }), {
      description: translate("workspace.operation.restoreVersion.description", {
        min: OPERATION_PROFILES.restoreVersion.minMinutes,
        max: OPERATION_PROFILES.restoreVersion.maxMinutes,
      }),
    });
    operation.begin("restoreVersion");
  }, [projectId, refuseWhileBusy, serverWake, operation]);

  /**
   * ⭐ EVERY STORED PATCH IN THE CONVERSATION, BY THE VERSION IT PRODUCED. A run's
   * `finished` message carries both `gitDiffUrl` and `versionId`; the versions list knows
   * the commit but not the patch. This index lets version history use the STORED patch —
   * the route that works with the project asleep — and fall back to the commit only when
   * it has to. See `DiffSource` in `DiffViewer.tsx`.
   */
  const storedPatchByVersion = useMemo(() => {
    const index = new Map<string, string>();
    for (const message of messages) {
      if (message.versionId && message.gitDiffUrl) index.set(message.versionId, message.gitDiffUrl);
    }
    return index;
  }, [messages]);
  const storedPatchFor = useCallback((versionId: string) => storedPatchByVersion.get(versionId), [storedPatchByVersion]);
  const openVersionDiff = useCallback((version: ProjectVersion) => {
    setDiffSource({
      projectId,
      url: storedPatchFor(version._id),
      commitSha: version.commitSha,
      versionId: version._id,
    });
  }, [projectId, storedPatchFor]);

  const openEntry = (id: WorkspaceModal) => {
    setOpenModal(id);
  };

  const isBuilding = project?.agentProcessStatus === "init";
  /** New engine: the live run timeline (`agent/progress`) for the chat and the preview loader. */
  const isV2 = isV2Project(project);
  const runProgress = useRunProgress(projectId, isBuilding, isV2);
  /**
   * ⚠️ A FINISHED GENERATION CHANGES THE SOURCE, AND THE LIVE-PREVIEW STATUS IS A
   * ONE-SHOT READ. `LiveRuntimePreview` fetches `/api/runtime/{id}` on mount and
   * whenever its `refreshKey` changes; before this counter existed, a generation
   * that completed while the preview tab was open never re-read it, so a status
   * captured when `project_files` was still empty ("This project has no
   * package.json…") stayed on screen after the files existed. Bumping once per
   * finished run re-reads the status; it never starts a sandbox.
   */
  const [runtimeStatusKey, setRuntimeStatusKey] = useState(0);
  const finishedRunKey = runProgress && isRunOver(runProgress.stage) ? runProgress.runId : null;
  useEffect(() => {
    if (!finishedRunKey) return;
    setRuntimeStatusKey((value) => value + 1);
  }, [finishedRunKey]);
  const buildStage = runProgress && !isRunOver(runProgress.stage) ? runProgress.stage : null;
  const buildRetrying = runProgress?.retrying ?? false;
  const previewReady = runProgress?.previewReady ?? false;
  const hasSuccessfulWebsite =
    Boolean(previewUrl) ||
    messages.some((message) => message.messageType === "finished");
  const showInitialGenerationLoader = isBuilding && !hasSuccessfulWebsite;
  const verifiedInitialPreviewUrl = showInitialGenerationLoader && isV2 && previewReady
    ? `/api/preview/${encodeURIComponent(projectId)}/`
    : null;
  const shownPreviewUrl = previewUrl ?? verifiedInitialPreviewUrl;
  /**
   * During a drag the committed state is stale until pointerup, so a rerender caused by
   * anything else must still read the live width. The drag itself never waits on React.
   */
  const liveChatWidth = isResizing && resizeRef.current ? resizeRef.current.currentWidth : chatWidth;
  const leftHeaderWidth = chatCollapsed ? "auto" : liveChatWidth + CHAT_DIVIDER_WIDTH;
  const pageBg = darkMode ? "var(--clay-base)" : "var(--clay-base)";
  const cardBg = darkMode ? "var(--clay-surface)" : "var(--clay-surface)";
  const btnBorder = "border-[var(--clay-line)]";

  if (loading) return <div className="h-screen flex flex-col items-center justify-center gap-3 " style={{ background: pageBg }}><Loader2 className="w-7 h-7 animate-spin" /><p className="text-sm text-muted-foreground">{"Loading..."}</p></div>;
  if (!project) return <div className="h-screen flex flex-col items-center justify-center gap-4 " style={{ background: pageBg }}><p className="text-muted-foreground">Project not found</p><Link href="/dashboard"><Button variant="outline">{"Back"}</Button></Link></div>;
  if (project.projectId !== projectId) return <div className="h-screen flex items-center justify-center bg-[var(--clay-base)] text-sm text-muted-foreground">Loading project…</div>;
  if (project.projectType === "android") return <AndroidWorkspace key={project.projectId} project={project} />;

  // Popup menu content (shared between desktop and mobile)
  const popupMenu = menuOpen && (
    <div data-popup-menu className="absolute top-full left-0 mt-1.5 w-56 rounded-xl border border-[var(--clay-line)] bg-card shadow-[var(--clay-float)] z-[60] overflow-hidden" style={{ backgroundImage: "var(--clay-sheen)" }}>
      <div className="px-3 py-2 border-b border-[var(--clay-line)]">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{projectId}</p>
      </div>
      <div className="py-1">
        <button onClick={() => { setMenuOpen(false); router.push("/dashboard"); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
          <FolderOpen className="w-4 h-4 text-muted-foreground" /> {"My projects"}
        </button>
        <button onClick={() => { setMenuOpen(false); router.push("/dashboard"); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
          <Plus className="w-4 h-4 text-muted-foreground" /> {"New project"}
        </button>
        <button onClick={() => { setMenuOpen(false); router.push("/upgrade"); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
          <Sparkles className="w-4 h-4 text-muted-foreground" /> {"Upgrade plan"}
        </button>
        <button onClick={() => { setMenuOpen(false); router.push("/credit-topup"); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
          <Sparkles className="w-4 h-4 text-muted-foreground" /> {"Top up credits"}
        </button>
      </div>
      {/* Tabs - visible on mobile only */}
      <div className="sm:hidden border-t border-[var(--clay-line)] py-1">
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setMobileTab("panel"); setMenuOpen(false); }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-[box-shadow,background-color] duration-200 ${activeTab === tab.id ? "bg-[var(--clay-sunken)] shadow-[var(--clay-well-1)] text-foreground font-semibold" : "text-foreground hover:bg-[var(--clay-sunken)]"}`}>
            <tab.icon className="w-4 h-4 text-muted-foreground" /> {tab.label}
          </button>
        ))}
      </div>
      {/* The errands — each opens a dialog over the workspace */}
      <div className="border-t border-[var(--clay-line)] py-1">
        {MODAL_ENTRIES.map((entry) => {
          const connected = (entry.id === "github" && githubConnected) || (entry.id === "figma" && figmaConnected);
          return (
            <button key={entry.id} onClick={() => { openEntry(entry.id); setMenuOpen(false); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
              <span className="relative flex items-center">
                <entry.icon className="w-4 h-4 text-muted-foreground" />
                {connected && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-success ring-2 ring-white dark:ring-[#1e1e1e]" />}
              </span>
              <span className="flex-1 text-left">{entry.label}</span>
              {connected && <span className="text-[10px] font-medium text-success">{"Connected"}</span>}
            </button>
          );
        })}
        <button onClick={() => { setMenuOpen(false); void openClone(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
          <Copy className="w-4 h-4 text-muted-foreground" /> {"Duplicate project"}
        </button>
      </div>
      <div className="border-t border-[var(--clay-line)] py-1">
      </div>
      <div className="border-t border-[var(--clay-line)] py-1">
        <button onClick={() => { handleRestartServer(); setMenuOpen(false); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color] duration-200 text-foreground">
          <Server className="w-4 h-4 text-muted-foreground" /> {"Restart Agent Server"}
        </button>
      </div>
    </div>
  );

  /**
   * ⭐ AFTER A "RESTORE CODE" ACTION. The restore replaced the project's source
   * on the server, so the project, the conversation (which now carries the
   * restore's own message) and the preview frame are all stale. Re-reading them
   * here is what makes the workspace show the restored code.
   */
  function handleRestored(): void {
    void fetchProject();
    void fetchConversation();
    invalidateCodeCache(projectId);
    setPreviewKey((k) => k + 1);
    setSourceRevision((revision) => revision + 1);
  }

  // The chat's composer props that both layouts share — the tool tray's wiring.
  const composerProps = {
    v2: isV2Project(project),
    runProgress,
    onRestored: handleRestored,
    onClearContext: async () => {
      const res = await vcaasApi.agent.clearContext(projectId);
      if (res.ok) toast.success(translate("workspace.chat.runOptions.clearContextDone"));
      else toast.error(res.error || translate("workspace.chat.runOptions.clearContextFailed"));
    },
    attachedFiles,
    setAttachedFiles,
    onOpenFigma: () => setOpenModal("figma"),
    figmaConnected,
    onDisconnectFigma: handleDisconnectFigma,
    onOpenGithub: () => setOpenModal("github"),
    onGithubStatusChange: setGithubConnected,
    /**
     * The composer's "Pull from GitHub" opens the dialog, where the import
     * lives with its plan and its confirmation.
     */
    onGithubPull: () => setOpenModal("github"),
    githubPulling: false,
  };

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden " style={{ background: pageBg }} onClickCapture={markWorkspaceTouched}>
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}

      {/* ═══ DESKTOP LAYOUT ═══ */}
      <div className="hidden sm:flex flex-col h-full min-h-0">
        {/* Desktop header 48px */}
        <header data-workspace-header className="flex items-stretch shrink-0 z-10 border-b border-[var(--clay-line)] bg-card" style={{ height: 48, backgroundImage: "var(--clay-sheen)", boxShadow: "var(--clay-elev-1)" }}>
          {/* LEFT: aside width */}
          <div ref={leftHeaderRef} className="flex items-center gap-1.5 px-3 shrink-0" style={{ width: typeof leftHeaderWidth === "number" ? leftHeaderWidth : undefined }}>
            <button type="button" onClick={() => { setLeaveWorkspaceHref("/dashboard"); setLeaveWorkspaceOpen(true); }} title="Back to Mavly" aria-label="Back to Mavly" className="h-7 px-1.5 flex items-center gap-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--clay-sunken)] transition-[box-shadow,background-color,color] duration-200 shrink-0">
              <ArrowLeft className="w-4 h-4" />
              <Image src="/logo/Mavly.png" alt="" width={18} height={18} className="w-4.5 h-4.5 rounded object-contain shrink-0" priority referrerPolicy="no-referrer" />
            </button>
            <div className="relative flex-1 min-w-0" ref={menuRef}>
              <button onClick={() => setMenuOpen(!menuOpen)} className="flex items-center gap-1.5 max-w-full rounded-lg px-1.5 py-1 hover:bg-[var(--clay-sunken)] transition-[box-shadow,background-color] duration-200">
                <Image src="/logo/Mavly.png" alt="Mavly" width={20} height={20} className="w-5 h-5 rounded object-contain shrink-0" priority referrerPolicy="no-referrer" />
                <span className="text-sm font-medium text-foreground truncate">{project.label || projectId}</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
              </button>
              {popupMenu}
            </div>
            <button onClick={() => setOpenModal("versions")} className={`h-7 w-7 flex items-center justify-center rounded-lg transition-[box-shadow,background-color,color] duration-200 shrink-0 border ${btnBorder} bg-card text-muted-foreground shadow-[var(--clay-elev-1)] hover:text-foreground active:shadow-[var(--clay-well-1)]`} title={translate("workspace.versions.title")}>
              <Clock className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setChatCollapsed(!chatCollapsed)} className={`h-7 w-7 flex items-center justify-center rounded-lg bg-card text-muted-foreground border ${btnBorder} shadow-[var(--clay-elev-1)] hover:text-foreground active:shadow-[var(--clay-well-1)] transition-[box-shadow,background-color,color] duration-200 shrink-0`}>
              {chatCollapsed ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
            </button>
          </div>
          {/* RIGHT: preview width */}
          <div className="flex items-center flex-1 min-w-0 gap-1.5 px-3">
            <div className="flex items-center gap-1 shrink-0">
              {TABS.map((tab) => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-sm font-medium transition-[box-shadow,background-color,color] duration-200 border ${btnBorder} ${activeTab === tab.id ? "bg-[var(--clay-sunken)] text-foreground shadow-[var(--clay-well-2)] font-semibold" : "text-muted-foreground hover:text-foreground hover:bg-[var(--clay-sunken)] bg-transparent"}`}>
                  <tab.icon className="w-3.5 h-3.5" /><span className="hidden lg:inline">{tab.label}</span>
                </button>
              ))}
            </div>
            <div className="flex-1 flex items-center justify-center min-w-0">
              <div className={`flex items-center h-7 w-[320px] rounded-full border ${btnBorder} bg-[var(--clay-sunken)] px-1.5 gap-1 shadow-[var(--clay-well-1)]`}>
                <button onClick={() => setMobilePreview(!mobilePreview)} className="p-1 rounded text-muted-foreground hover:text-muted-foreground dark:hover:text-muted-foreground shrink-0">{mobilePreview ? <Smartphone className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}</button>
                {/*
                  ⭐ THE ADDRESS BOX LISTS THE PROJECT'S OWN PAGES. It was a bare text
                  input, so reaching any page but `/` meant knowing its URL by heart.
                  `PathPicker` (the platform's, copied) reads the file tree — free, not
                  the charged source download — turns the route files into a list, and
                  filters it as you type; picking one navigates the preview.
                */}
                <PathPicker
                  projectId={projectId}
                  path={iframePath}
                  onPathChange={setIframePath}
                  onRefresh={() => setPreviewKey((k) => k + 1)}
                  className="flex-1 min-w-0"
                />
                <button className="p-1 rounded text-muted-foreground hover:text-muted-foreground dark:hover:text-muted-foreground shrink-0" onClick={() => { fetchProject(); setPreviewKey((k) => k + 1); }}><RefreshCw className="w-3.5 h-3.5" /></button>
                {previewUrl && <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded text-muted-foreground hover:text-muted-foreground dark:hover:text-muted-foreground shrink-0"><ExternalLink className="w-3.5 h-3.5" /></a>}
              </div>
            </div>
            <CreditsIndicator refreshKey={isBuilding ? "running" : "idle"} />
          </div>
        </header>
        {/* Desktop main */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div
            ref={chatColumnRef}
            className={`flex flex-col min-h-0 shrink-0 ${isResizing ? "" : "transition-[width]"} ${chatCollapsed ? "w-0 overflow-hidden" : ""}`}
            style={chatCollapsed ? {} : { width: liveChatWidth, background: cardBg }}
          >
            <ChatPanel
              messages={messages} isBuilding={isBuilding} prompt={prompt} setPrompt={setPrompt} onSend={handleSendPrompt} onRetryPrompt={(text, files) => { void sendPromptText(text, files); }} onStop={handleStopAgent} sending={sending} projectId={projectId} projectSecrets={project?.secrets}
              runStartedAt={runStartedAt} expectedMinutes={expectedMinutes}
              {...composerProps}
              visualEditAvailable
              visualEditActive={visualEditorOpen}
              visualEditBusy={visualLocked}
              onToggleVisualEdit={handleToggleVisualEdit}
            />
          </div>
          {!chatCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat panel"
              aria-valuemin={CHAT_MIN_WIDTH}
              aria-valuemax={CHAT_MAX_WIDTH}
              aria-valuenow={chatWidth}
              tabIndex={0}
              className="flex w-1 hover:w-1.5 bg-transparent hover:bg-[var(--clay-sunken-deep)] dark:hover:bg-[var(--clay-sunken-deep)] cursor-col-resize transition-colors items-center justify-center shrink-0 touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--clay-line)]"
              onPointerDown={handleResizeStart}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
              onLostPointerCapture={finishResize}
              onKeyDown={handleResizeKeyDown}
            >
              <div className="w-0.5 h-8 bg-[var(--clay-sunken-deep)] rounded-full" />
            </div>
          )}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            {/*
              ⭐ THE OPERATION BANNER, ABOVE EVERYTHING IT AFFECTS. Publish, pull,
              restore and restart all replace or take down the app the panel below is
              showing, so the explanation belongs above that panel and not in a toast that
              is gone before the work is.
            */}
            {/* New-engine projects: paused / emergency stop / database move / last publish failed (renders nothing otherwise). */}
            <V2Banner project={project} onChanged={() => void fetchProject()} onAskFix={setPrompt} />
            {operation.kind && (
              <div className="px-2 pt-2 sm:px-3">
                <OperationBanner kind={operation.kind} elapsedMs={operation.elapsedMs} />
              </div>
            )}
            {/*
              ⭐ THE WAKE STRIP, ABOVE THE PANEL THAT OWNS THE ACTION. It is a strip in the
              panel column, never an overlay, so the rest of the workspace stays usable
              while the server comes up — the dialog is the interruption, this is the progress.
            */}
            {(serverWake.waking || serverWake.failed) && (
              <div className="px-2 pt-2 sm:px-3">
                <ServerWakeNotice wake={serverWake} manualRetry={!serverWake.willRetry} />
              </div>
            )}
            <div className={`flex-1 min-h-0 overflow-hidden ${activeTab === "preview" ? "rounded-none" : "m-2 sm:m-3 rounded-xl border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]"}`} style={{ background: cardBg }}>
              {activeTab === "preview" && (
                <LiveRuntimePreview
                  projectId={projectId}
                  refreshKey={previewKey + sourceRevision + runtimeStatusKey}
                  mobilePreview={mobilePreview}
                >
                  <PreviewPanel key={previewKey} previewUrl={shownPreviewUrl} cached={previewCached} onRefresh={() => { fetchProject(); setPreviewKey((k) => k + 1); }} loading={showInitialGenerationLoader} buildStage={buildStage} buildRetrying={buildRetrying} previewReady={previewReady} emptyMessage={project?.previewUnavailableReason} previewState={project?.previewState} onResumeGeneration={handleResumeGeneration} resumingGeneration={resumingGeneration} mobilePreview={mobilePreview} iframePath={iframePath} frameRef={previewFrameRef} /* ⭐ Same-origin ONLY while the editor is open — and for the length of an apply, which outlives the panel: dropping the proxy mid-apply would reload the frame and throw away the preview-only edits the user is watching. */ proxiedSrc={visualEditorOpen || visualLocked ? `/api/preview/${encodeURIComponent(projectId)}` : null} />
                </LiveRuntimePreview>
              )}
              {activeTab === "code" && <CodePanel key={`${projectId}:${sourceRevision}`} projectId={projectId} sourceRevision={sourceRevision} darkMode={darkMode} onAskAiEdit={handleAskAiEdit} wake={serverWake} />}
              {activeTab === "more" && <WorkspaceMore
                project={project}
                onProjectChanged={() => void fetchProject()}
                completionSoundsEnabled={completionSounds.enabled}
                completionSoundError={completionSounds.error}
                onEnableCompletionSounds={completionSounds.enable}
                onDisableCompletionSounds={completionSounds.disable}
              />}
            </div>
            {/* The unsaved-changes bar owns the whole batch: count, undo, discard and apply. */}
            <VisualChangesBar
              changes={visual.changes}
              phase={visual.phase}
              outcome={visual.outcome}
              error={visual.error}
              onUndo={visual.undoChange}
              onDiscardAll={visual.discardAll}
              onApply={handleVisualApply}
              onDismissOutcome={visual.reset}
            />
          </div>
          {/*
            ⚠️ A COLUMN, NOT AN OVERLAY — the inspector must never cover the element being
            edited, which is the one thing the user is looking at.
          */}
          {visualEditorOpen && (
            <div className="w-[19rem] min-h-0 shrink-0 xl:w-[21rem] overflow-hidden border-l border-[var(--clay-line)]">
              <VisualEditorPanel
                projectId={projectId}
                selected={visual.selected}
                ready={visual.ready}
                locked={visualLocked}
                palette={visual.palette}
                onChange={(kind, before, after, options) => {
                  if (!visual.selected) return;
                  visual.pushChange(kind, before, after, visual.selected.signature, options);
                }}
                onAskAi={seed => {
                  setPrompt(seed);
                  setChatCollapsed(false);
                  setMobileTab("chat");
                  requestAnimationFrame(() => {
                    document.querySelector<HTMLTextAreaElement>("[data-chat-input]")?.focus();
                  });
                }}
                /**
                 * ⚠️ CLOSING DISCARDS THE BATCH, and that is the honest reading of
                 * "nothing is saved until you apply": the frame swaps back to the direct
                 * preview where none of these edits exist, so leaving them in the bar
                 * would let someone apply changes they can no longer see.
                 */
                onClose={() => {
                  visual.discardAll();
                  setVisualEditorOpen(false);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ═══ MOBILE LAYOUT: header → content → fixed switch → fixed textarea ═══ */}
      <div className="flex sm:hidden flex-col h-full min-h-0">
        {/* Mobile header */}
        <header data-workspace-header className="flex items-center gap-1.5 px-2 shrink-0 z-10 border-b border-[var(--clay-line)] bg-card" style={{ height: 44, backgroundImage: "var(--clay-sheen)", boxShadow: "var(--clay-elev-1)" }}>
          <button type="button" onClick={() => { setLeaveWorkspaceHref("/"); setLeaveWorkspaceOpen(true); }} title="Back to Mavly" aria-label="Back to Mavly" className="h-7 px-1.5 flex items-center gap-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--clay-sunken)] transition-[box-shadow,background-color,color] duration-200 shrink-0">
            <ArrowLeft className="w-4 h-4" />
            <Image src="/logo/Mavly.png" alt="" width={18} height={18} className="w-4.5 h-4.5 rounded object-contain shrink-0" priority referrerPolicy="no-referrer" />
          </button>
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen(!menuOpen)} className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--clay-sunken)] dark:hover:bg-card/10 transition-colors">
              <Image src="/logo/Mavly.png" alt="Mavly" width={20} height={20} className="w-5 h-5 rounded object-contain shrink-0" priority referrerPolicy="no-referrer" />
              <span className="text-sm font-medium text-foreground truncate max-w-[160px]">{project.label || projectId}</span>
              <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
            </button>
            {popupMenu}
          </div>
        </header>

        {/*
          ⭐ THE WAKE STRIP ON MOBILE, ABOVE BOTH TABS. The desktop strip lives in the
          panel column, which on a phone is a SEPARATE VIEW from the chat — so a server
          started from the composer came up with no visible sign of it anywhere. Here it
          sits above the switch, so the wait is on screen whichever tab is open.
        */}
        {(serverWake.waking || serverWake.failed) && (
          <div className="shrink-0 px-2 pt-2">
            <ServerWakeNotice wake={serverWake} manualRetry={!serverWake.willRetry} />
          </div>
        )}

        <V2Banner project={project} onChanged={() => void fetchProject()} onAskFix={(text) => { setPrompt(text); setMobileTab("chat"); }} />

        {/* Mobile content area */}
        <div className="flex-1 min-h-0 overflow-hidden" style={{ background: cardBg }}>
          {mobileTab === "chat" ? (
            <div className="flex flex-col h-full min-h-0">
              {/* ⚠️ No pencil here: the visual editor is a desktop surface (see the frame-ref note). */}
              <ChatPanel messages={messages} isBuilding={isBuilding} prompt={prompt} setPrompt={setPrompt} onSend={handleSendPrompt} onRetryPrompt={(text, files) => { void sendPromptText(text, files); }} onStop={handleStopAgent} sending={sending} projectId={projectId} projectSecrets={project?.secrets} runStartedAt={runStartedAt} expectedMinutes={expectedMinutes} {...composerProps} />
            </div>
          ) : (
            <div className="h-full min-h-0 overflow-hidden">
              {activeTab === "preview" && (
                <LiveRuntimePreview projectId={projectId} refreshKey={previewKey + sourceRevision + runtimeStatusKey}>
                  <PreviewPanel key={previewKey} previewUrl={shownPreviewUrl} cached={previewCached} onRefresh={() => { fetchProject(); setPreviewKey((k) => k + 1); }} loading={showInitialGenerationLoader} buildStage={buildStage} buildRetrying={buildRetrying} previewReady={previewReady} emptyMessage={project?.previewUnavailableReason} previewState={project?.previewState} onResumeGeneration={handleResumeGeneration} resumingGeneration={resumingGeneration} mobilePreview={false} iframePath={iframePath} />
                </LiveRuntimePreview>
              )}
              {activeTab === "code" && <CodePanel key={`${projectId}:${sourceRevision}`} projectId={projectId} sourceRevision={sourceRevision} darkMode={darkMode} onAskAiEdit={handleAskAiEdit} wake={serverWake} />}
              {activeTab === "more" && <WorkspaceMore
                project={project}
                onProjectChanged={() => void fetchProject()}
                completionSoundsEnabled={completionSounds.enabled}
                completionSoundError={completionSounds.error}
                onEnableCompletionSounds={completionSounds.enable}
                onDisableCompletionSounds={completionSounds.disable}
              />}
            </div>
          )}
        </div>

        {/* Fixed switch: Preview / Chat */}
        <div className="shrink-0 flex items-center justify-center py-2 px-4" style={{ background: pageBg }}>
          <div className="flex rounded-full border border-[var(--clay-line)] bg-[var(--clay-sunken)] p-1 w-full max-w-xs shadow-[var(--clay-well-2)]">
            <button onClick={() => setMobileTab("panel")} className={`w-1/2 py-2 rounded-full text-sm font-medium text-center transition-[box-shadow,color] duration-200 ${mobileTab === "panel" ? "bg-card text-foreground shadow-[var(--clay-elev-1)]" : "text-muted-foreground"}`}>{"Preview"}</button>
            <button onClick={() => setMobileTab("chat")} className={`w-1/2 py-2 rounded-full text-sm font-medium text-center transition-[box-shadow,color] duration-200 ${mobileTab === "chat" ? "bg-card text-foreground shadow-[var(--clay-elev-1)]" : "text-muted-foreground"}`}>{"Chat"}</button>
          </div>
        </div>
      </div>

      {/*
        ⭐ MOUNTED ONCE FOR THE WHOLE WORKSPACE. It listens for the wake's own event, so a
        refusal raised inside any dialog — the code editor, the GitHub modal, the versions
        list — is answered here without a single prop being threaded through.
      */}
      <ConfirmDialog
        open={leaveWorkspaceOpen}
        onOpenChange={setLeaveWorkspaceOpen}
        title="Leave this workspace?"
        description="You'll return to the Mavly dashboard. Any unsaved changes may be lost."
        cancelLabel="Stay here"
        confirmLabel="Leave workspace"
        confirmClassName="bg-primary text-primary-foreground shadow-[var(--clay-elev-ink-1)]"
        onConfirm={() => router.push(leaveWorkspaceHref)}
      />
      <ServerBlockedDialog reason={blocked.reason} onDismiss={blocked.dismiss} wake={serverWake} />

      {/* ═══ THE ERRANDS — totalum-platform's dialogs, copied unchanged ═══ */}
      <VersionsModal
        open={openModal === "versions"}
        onOpenChange={open => setOpenModal(open ? "versions" : null)}
        projectId={projectId}
        onViewDiff={openVersionDiff}
        storedPatchFor={storedPatchFor}
        restoring={restoringVersion}
        onRestore={handleRestoreVersion}
        blockedReason={restoringVersion ? null : operationBusyReason}
      />
      <DiffViewer
        open={!!diffSource}
        onOpenChange={open => { if (!open) setDiffSource(null); }}
        source={diffSource}
      />
      <SecretsModal
        open={openModal === "secrets"}
        onOpenChange={open => setOpenModal(open ? "secrets" : null)}
        projectId={projectId}
        secrets={project.secrets ?? []}
        onChanged={() => void fetchProject()}
      />
      <ProjectDomainPanel
        open={openModal === "domain"}
        onOpenChange={open => setOpenModal(open ? "domain" : null)}
        project={project}
      />
      <GithubModal
        open={openModal === "github"}
        onOpenChange={open => setOpenModal(open ? "github" : null)}
        projectId={projectId}
        onStatusChange={setGithubConnected}
        /* ⭐ AN IMPORT REPLACED THE PROJECT'S SOURCE: the workspace re-reads it. */
        onProjectChanged={handleRestored}
      />
      {/* ⭐ Duplicate — the dashboard's dialog; on success it navigates to the copy itself. */}
      <CloneProjectDialog
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        projectId={projectId}
        projectType={project.projectType ?? "website"}
        takenNames={takenNames}
        onCloned={() => {}}
      />
      <FigmaModal
        open={openModal === "figma"}
        onOpenChange={open => setOpenModal(open ? "figma" : null)}
        projectId={projectId}
        onStatusChange={setFigmaConnected}
      />
      {/*
        ═══⭐⭐ THE IMPORT OVERLAY — the one operation that covers the screen ═══════
        A clone or import replaces EVERYTHING underneath: code, data, the running server.
        There is nothing to work with until it lands, so the platform covers the workspace
        with its first-build narrative rather than a banner. Copied unchanged; it renders
        whenever the slot says `import`, which the dashboard stamps before navigating here
        and the load effect adopts from the server's own lock after a reload.
      */}
      {operation.kind === "import" && (
        <ImportOverlay elapsedMs={operation.elapsedMs} projectId={projectId} />
      )}
    </div>
  );
}
