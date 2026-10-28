"use client";

import { useCallback, useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  AlertCircle, ArrowLeft, Bot, Check, ChevronDown, ChevronRight, Code2, Download, Eye,
  FileCode2, Folder, FolderOpen, GitBranch, LayoutGrid, Loader2, MessageSquare,
  RefreshCw, Search, Send, Smartphone, User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { vcaasApi } from "@/lib/vcaas";
import { CreditsIndicator } from "@/components/workspace/CreditsIndicator";
import { GithubModal } from "@/components/workspace/GithubModal";
import { silenceMonacoDiagnostics } from "@/lib/monaco-diagnostics";
import { PremiumAiActivity, type ActivityChecklistStage } from "@/components/workspace/GenerationProgressVisuals";
import { RunProgress } from "@/components/workspace/RunProgress";
import { useRunClock } from "@/components/workspace/use-run-clock";
import type {
  AgentStatus, ConversationMessage, FileContent, FileTreeEntry, MobileBuild, VcaasProject,
} from "@/lib/vcaas-types";
import type { AndroidCapability } from "@/lib/android/capability";

const CONVERSATION_PAGE_SIZE = 80;

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  ),
});

function androidLanguageFromPath(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name.endsWith(".kt") || name.endsWith(".kts")) return "kotlin";
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".json") || name.endsWith(".json5")) return "json";
  if (name.endsWith(".properties") || name.endsWith(".gradle") || name === "gradle.properties") return "ini";
  if (name.endsWith(".toml")) return "ini";
  if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".readme")) return "plaintext";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  return "plaintext";
}

function fileMatchesSearch(path: string, search: string): boolean {
  return !search.trim() || path.toLowerCase().includes(search.trim().toLowerCase());
}

type CodeTreeNode = {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: CodeTreeNode[];
};

function buildCodeTree(entries: FileTreeEntry[], search: string): CodeTreeNode[] {
  const root: CodeTreeNode[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !fileMatchesSearch(entry.path, search)) continue;
    const parts = entry.path.split("/").filter(Boolean);
    let level = root;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      if (isFile) {
        level.push({ name: part, path: entry.path, type: "file" });
        return;
      }
      let folder = level.find((node) => node.type === "folder" && node.path === currentPath);
      if (!folder) {
        folder = { name: part, path: currentPath, type: "folder", children: [] };
        level.push(folder);
      }
      level = folder.children ?? [];
    });
  }
  const sortNodes = (nodes: CodeTreeNode[]): CodeTreeNode[] => nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const sortChildren = (nodes: CodeTreeNode[]) => {
    sortNodes(nodes);
    nodes.forEach((node) => node.children && sortChildren(node.children));
  };
  sortChildren(root);
  return root;
}

export function AndroidWorkspace({ project }: { project: VcaasProject }) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(true);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [files, setFiles] = useState<FileTreeEntry[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [buildsOpen, setBuildsOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [mobileView, setMobileView] = useState<"preview" | "code" | "more">("preview");
  const [codeSearch, setCodeSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set([""]));
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [builds, setBuilds] = useState<MobileBuild[] | null>(null);
  const [buildCapability, setBuildCapability] = useState<AndroidCapability | undefined>(
    project.android,
  );
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildStarting, setBuildStarting] = useState(false);
  const [buildLogs, setBuildLogs] = useState<Record<string, { text: string; truncated: boolean }>>({});
  const contentRequest = useRef(0);
  const completedRun = useRef<string | null>(null);
  const conversationOffset = useRef(0);
  const noOlderMessages = useRef(false);
  const preserveChatScroll = useRef<{ height: number; top: number } | null>(null);
  const startingRef = useRef(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const loadFiles = useCallback(async () => {
    setRefreshing(true);
    setFilesError(null);
    try {
      const response = await vcaasApi.files.tree(project.projectId, { limit: 5_000 });
      if (!response.ok || !response.data) {
        setFilesError(response.error || "Could not load this project's source files.");
        setFiles(null);
        return;
      }

      const sourceFiles = response.data.entries.filter((entry) => entry.type === "file");
      setFiles(sourceFiles);
      setSelectedPath((current) =>
        current && sourceFiles.some((entry) => entry.path === current)
          ? current
          : sourceFiles[0]?.path ?? null,
      );
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : "Could not load this project's source files.");
      setFiles(null);
    } finally {
      setRefreshing(false);
    }
  }, [project.projectId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const loadConversation = useCallback(async (older = false) => {
    setConversationLoading(true);
    try {
      const offsetFromEnd = older
        ? conversationOffset.current + CONVERSATION_PAGE_SIZE
        : 0;
      const response = await vcaasApi.agent.fullConversation(project.projectId, {
        limit: CONVERSATION_PAGE_SIZE,
        ...(offsetFromEnd > 0 ? { offsetFromEnd } : {}),
      });
      if (!response.ok || !response.data) {
        setConversationError(response.error || "Could not load this project's conversation.");
        return;
      }

      const page = response.data.conversation;
      setConversationError(null);
      if (older) {
        if (page.length > 0) {
          if (chatScrollRef.current) {
            preserveChatScroll.current = {
              height: chatScrollRef.current.scrollHeight,
              top: chatScrollRef.current.scrollTop,
            };
          }
          setMessages((current) => [...page, ...current]);
          conversationOffset.current = offsetFromEnd;
        }
        if (page.length < CONVERSATION_PAGE_SIZE) noOlderMessages.current = true;
        setHasOlderMessages(page.length === CONVERSATION_PAGE_SIZE);
      } else {
        setMessages((current) => {
          const previouslyLoaded = current.slice(0, Math.max(0, current.length - CONVERSATION_PAGE_SIZE));
          return [...previouslyLoaded, ...page];
        });
        setHasOlderMessages(page.length === CONVERSATION_PAGE_SIZE && !noOlderMessages.current);
      }
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : "Could not load this project's conversation.");
    } finally {
      setConversationLoading(false);
    }
  }, [project.projectId]);

  useEffect(() => {
    const key = `mavly:android-generation:${project.projectId}`;
    try {
      const saved = window.sessionStorage.getItem(key);
      if (!saved) return;
      window.sessionStorage.removeItem(key);

      const parsed: unknown = JSON.parse(saved);
      if (typeof parsed !== "object" || parsed === null) return;
      if ("prompt" in parsed && typeof parsed.prompt === "string") setPrompt(parsed.prompt);
      if ("error" in parsed && typeof parsed.error === "string") setGenerationError(parsed.error);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Could not restore the Android generation request.");
    }
  }, [project.projectId]);

  const refreshStatus = useCallback(async () => {
    void loadConversation();
    try {
      const response = await vcaasApi.agent.status(project.projectId);
      if (!response.ok || !response.data) {
        setStatusError(response.error || "Could not load the generation status.");
        return;
      }
      setStatusError(null);
      setStatus(response.data);
      if (response.data.status === "done" && completedRun.current !== response.data.runId) {
        completedRun.current = response.data.runId ?? null;
        void loadFiles();
      }
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "Could not load the generation status.");
    }
  }, [loadConversation, loadFiles, project.projectId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const inFlight = status?.status === "init";
  const stageIsTerminal =
    status?.stage === "completed" ||
    status?.stage === "failed" ||
    status?.stage === "cancelled" ||
    status?.stage === "interrupted";
  const startedAt = status?.startedAt ? Date.parse(status.startedAt) : NaN;
  const { elapsedMs } = useRunClock({
    projectId: project.projectId,
    isRunning: inFlight,
    startedAtFromStream: Number.isFinite(startedAt) ? startedAt : null,
  });
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => void refreshStatus(), 3_500);
    return () => window.clearInterval(timer);
  }, [inFlight, refreshStatus]);

  const startGeneration = async () => {
    const text = prompt.trim();
    if (!text || startingRef.current || inFlight) return;
    startingRef.current = true;
    setStarting(true);
    setGenerationError(null);
    try {
      const response = await vcaasApi.agent.start(project.projectId, {
        prompt: text,
        inputFiles: [],
      });
      if (!response.ok) {
        setGenerationError(response.error || "Could not start Android source generation.");
        return;
      }
      setPrompt("");
      await refreshStatus();
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Could not start Android source generation.");
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  useEffect(() => {
    const scroll = chatScrollRef.current;
    if (!scroll) return;
    const previous = preserveChatScroll.current;
    if (previous) {
      preserveChatScroll.current = null;
      requestAnimationFrame(() => {
        scroll.scrollTop = previous.top + scroll.scrollHeight - previous.height;
      });
      return;
    }
    scroll.scrollTop = scroll.scrollHeight;
  }, [messages, inFlight]);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [prompt]);

  const saveFile = async () => {
    if (!selectedPath || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await vcaasApi.files.write(project.projectId, selectedPath, draft);
      if (!response.ok) {
        setSaveError(response.error || "Could not save this source file.");
        return;
      }
      setEditing(false);
      setFileContent((current) => (current ? { ...current, content: draft } : current));
      await loadFiles();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this source file.");
    } finally {
      setSaving(false);
    }
  };

  const downloadSource = async () => {
    setDownloading(true);
    setGenerationError(null);
    try {
      const response = await vcaasApi.sourceCode(project.projectId, "download");
      if (!response.ok) {
        setGenerationError("The source download was refused. Try again from a signed-in session.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.projectId}-android.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setGenerationError("Could not download the Android source.");
    } finally {
      setDownloading(false);
    }
  };

  const loadBuilds = useCallback(async () => {
    try {
      const response = await vcaasApi.v2.mobileBuilds(project.projectId);
      if (!response.ok || !response.data) {
        setBuildError(response.error || "Could not load Android builds.");
        setBuilds([]);
        return;
      }
      setBuildError(null);
      setBuilds(response.data.builds ?? []);
      if (response.data.capability) setBuildCapability(response.data.capability);
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Could not load Android builds.");
      setBuilds([]);
    }
  }, [project.projectId]);

  useEffect(() => {
    void loadBuilds();
  }, [loadBuilds]);

  const activeBuild = builds?.find(
    (build) =>
      build.state === "queued" ||
      build.state === "running" ||
      build.status === "queued" ||
      build.status === "running",
  );
  /**
   * Poll on the id, not the object: `activeBuild` is recomputed every render,
   * and depending on it would restart the interval on each state change. An id
   * of `null` (terminal/no build) still cleans up the interval.
   */
  const activeBuildId = activeBuild?.id ?? null;
  useEffect(() => {
    if (!activeBuildId) return;
    const timer = window.setInterval(() => void loadBuilds(), 5_000);
    return () => window.clearInterval(timer);
  }, [activeBuildId, loadBuilds]);

  const startBuild = async () => {
    if (buildStarting || activeBuild) return;
    setBuildStarting(true);
    setBuildError(null);
    try {
      const response = await vcaasApi.v2.startMobileBuild(
        project.projectId,
        "android",
        crypto.randomUUID(),
      );
      if (!response.ok) {
        setBuildError(response.error || "Could not start the Android build.");
        return;
      }
      await loadBuilds();
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Could not start the Android build.");
    } finally {
      setBuildStarting(false);
    }
  };

  const cancelBuild = async (buildId: string) => {
    setBuildError(null);
    const response = await vcaasApi.v2.cancelMobileBuild(project.projectId, buildId);
    if (!response.ok) {
      setBuildError(response.error || "Could not cancel the Android build.");
      return;
    }
    await loadBuilds();
  };

  const downloadArtifact = async (buildId: string) => {
    setBuildError(null);
    const response = await vcaasApi.v2.mobileBuildDownload(project.projectId, buildId);
    if (!response.ok || !response.data?.url) {
      setBuildError(response.error || "The Android artifact is not available.");
      return;
    }
    window.open(response.data.url, "_blank", "noopener,noreferrer");
  };

  const loadBuildLog = async (buildId: string) => {
    setBuildError(null);
    const response = await vcaasApi.v2.mobileBuildLog(project.projectId, buildId);
    if (!response.ok) {
      setBuildError(response.error || "Could not load the Android build log.");
      return;
    }
    setBuildLogs((current) => ({
      ...current,
      [buildId]: {
        text: response.data?.log ?? "",
        truncated: Boolean(response.data?.truncated),
      },
    }));
  };

  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    setDraft("");
  }, [selectedPath]);

  useEffect(() => {
    const requestId = ++contentRequest.current;
    if (!selectedPath) {
      setFileContent(null);
      setContentError(null);
      setContentLoading(false);
      return;
    }

    let active = true;
    setFileContent(null);
    setContentError(null);
    setContentLoading(true);
    void vcaasApi.files.content(project.projectId, selectedPath)
      .then((response) => {
        if (!active || requestId !== contentRequest.current) return;
        if (!response.ok || !response.data) {
          setContentError(response.error || "Could not load this source file.");
          return;
        }
        setFileContent(response.data);
        if (response.data.encoding === "utf8") setDraft(response.data.content);
      })
      .catch((error: unknown) => {
        if (!active || requestId !== contentRequest.current) return;
        setContentError(error instanceof Error ? error.message : "Could not load this source file.");
      })
      .finally(() => {
        if (active && requestId === contentRequest.current) setContentLoading(false);
      });

    return () => {
      active = false;
    };
  }, [project.projectId, selectedPath]);

  const projectName = project.label?.trim() || project.projectId;
  const generationFailed = status?.stage === "failed";
  const activityStages: ActivityChecklistStage[] = [
    {
      label: "Understanding prompt",
      status: status?.stage === "queued"
        ? "active"
        : status?.stage === "validating" || status?.stage === "generating"
          ? "completed"
          : "pending",
    },
    {
      label: "Validating Android source",
      status: status?.stage === "validating"
        ? "active"
        : status?.stage === "generating"
          ? "completed"
          : "pending",
    },
    {
      label: "Generating Kotlin and Compose",
      status: status?.stage === "generating" ? "active" : "pending",
    },
  ];
  const activityTitle = status?.stage === "queued"
    ? "Understanding prompt"
    : status?.stage === "validating"
      ? "Validating Android source"
      : status?.stage === "retrying"
        ? "Retrying generation"
        : status?.stage === "generating"
          ? "Generating Kotlin and Compose"
          : status?.stage === "failed"
            ? "Generation failed"
            : status?.stage === "cancelled"
              ? "Generation cancelled"
              : status?.stage === "interrupted"
                ? "Generation interrupted"
                : status?.stage === "completed"
                  ? "Generation complete"
                  : "Generating Android source";
  const runStatus = status?.status === "init"
    ? `Generating${status.stage ? ` · ${status.stage.replaceAll("_", " ")}` : "..."}`
    : generationFailed
      ? "Generation failed"
      : status?.stage === "cancelled"
        ? "Generation cancelled"
        : status?.stage === "interrupted"
          ? "Generation interrupted"
          : status?.stage === "completed" || status?.status === "done"
            ? "Generation complete"
            : "Ready";
  const latestBuild = builds?.[0];
  const latestBuildFailed = Boolean(
    buildError ||
    latestBuild?.status === "failed" ||
    latestBuild?.state === "failed" ||
    latestBuild?.state === "timed_out" ||
    latestBuild?.state === "configuration_error" ||
    latestBuild?.state === "infrastructure_error",
  );
  const latestBuildSucceeded = latestBuild?.state === "succeeded" || latestBuild?.status === "success";
  const buildStatus = activeBuild
    ? `APK ${activeBuild.state ?? activeBuild.status}`
    : latestBuildFailed
      ? "Build error"
      : latestBuildSucceeded
        ? "APK ready"
        : buildCapability?.build.available
          ? "Debug APK enabled"
          : "Kotlin source only";
  const codeTree = useMemo(() => buildCodeTree(files ?? [], codeSearch), [files, codeSearch]);
  const toggleFolder = (folderPath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };
  const renderCodeTree = (nodes: CodeTreeNode[], depth = 0): ReactNode => nodes.map((node) => (
    node.type === "folder" ? (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => toggleFolder(node.path)}
          className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {expandedFolders.has(node.path) || codeSearch.trim()
            ? <ChevronDown className="size-3.5 shrink-0" />
            : <ChevronRight className="size-3.5 shrink-0" />}
          {expandedFolders.has(node.path) || codeSearch.trim()
            ? <FolderOpen className="size-3.5 shrink-0 text-amber-600" />
            : <Folder className="size-3.5 shrink-0 text-amber-600" />}
          <span className="truncate">{node.name}</span>
        </button>
        {(expandedFolders.has(node.path) || codeSearch.trim()) && node.children
          ? renderCodeTree(node.children, depth + 1)
          : null}
      </div>
    ) : (
      <button
        key={node.path}
        type="button"
        onClick={() => setSelectedPath(node.path)}
        aria-current={selectedPath === node.path ? "page" : undefined}
        className={`flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs ${selectedPath === node.path ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"}`}
        style={{ paddingLeft: `${22 + depth * 14}px` }}
        title={node.path}
      >
        <FileCode2 className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  ))

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="z-10 shrink-0 border-b border-border bg-background">
        <div className="flex h-14 items-center justify-between gap-3 px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/dashboard" className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
              <ArrowLeft className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Projects</span>
            </Link>
            <span className="h-5 w-px bg-border" aria-hidden="true" />
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{projectName}</h1>
              <span className="hidden shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground sm:inline-flex">
                <Smartphone className="size-3" aria-hidden="true" />
                Android
              </span>
              <span className={`hidden max-w-48 truncate text-xs sm:inline ${generationFailed ? "text-destructive" : "text-muted-foreground"}`}>
                {runStatus}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`mr-1 hidden max-w-36 truncate text-xs md:inline ${buildError || latestBuildFailed ? "text-destructive" : "text-muted-foreground"}`}>
              {buildStatus}
            </span>
            <CreditsIndicator />
            <Button type="button" variant="outline" size="sm" onClick={() => setBuildsOpen(true)} className="h-8 gap-1.5 px-2.5" aria-label="Android build status">
              <Smartphone className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Builds</span>
            </Button>
            <Button type="button" variant={mobileView === "preview" ? "default" : "outline"} size="sm" onClick={() => setMobileView("preview")} className="h-8 gap-1.5 px-2.5" aria-label="Open Android app preview">
              <Eye className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Preview</span>
            </Button>
            <Button type="button" variant={mobileView === "code" ? "default" : "outline"} size="sm" onClick={() => setMobileView("code")} className="h-8 gap-1.5 px-2.5" aria-label="Open Android Code Explorer">
              <Code2 className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Code</span>
              {files?.length ? <span className="text-[10px] opacity-70">{files.length}</span> : null}
            </Button>
            <Button type="button" variant={mobileView === "more" ? "default" : "outline"} size="sm" onClick={() => setMobileView("more")} className="h-8 gap-1.5 px-2.5" aria-label="Open Android workspace More menu">
              <LayoutGrid className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">More</span>
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => void loadFiles()} disabled={refreshing} className="size-8" aria-label="Refresh source files">
              <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            </Button>
            {files && files.length > 0 ? (
              <Button type="button" variant="outline" size="icon" onClick={() => void downloadSource()} disabled={downloading} className="size-8" aria-label="Download Android source">
                {downloading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
              </Button>
            ) : null}
          </div>
        </div>
        <nav className="grid grid-cols-3 gap-1 border-t border-border p-1.5 md:hidden" aria-label="Workspace view">
          <button type="button" onClick={() => setMobileView("preview")} aria-pressed={mobileView === "preview"} className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${mobileView === "preview" ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
            <Eye className="size-3.5" aria-hidden="true" /> Preview
          </button>
          <button type="button" onClick={() => setMobileView("code")} aria-pressed={mobileView === "code"} className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${mobileView === "code" ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
            <Code2 className="size-3.5" aria-hidden="true" /> Code
          </button>
          <button type="button" onClick={() => setMobileView("more")} aria-pressed={mobileView === "more"} className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${mobileView === "more" ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
            <LayoutGrid className="size-3.5" aria-hidden="true" /> More
          </button>
        </nav>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section aria-label="AI chat" className="flex h-[42%] min-h-0 w-full shrink-0 flex-col border-b border-border bg-background md:h-auto md:w-[40%] md:border-b-0 md:border-r lg:w-[38%]">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-medium">Build your Android app</h2>
            </div>
            <span className={`inline-flex items-center gap-1.5 text-[11px] ${generationFailed ? "text-destructive" : "text-muted-foreground"}`}>
              {inFlight ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : status?.stage === "completed" ? <Check className="size-3" aria-hidden="true" /> : null}
              {runStatus}
            </span>
          </div>

          <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
            {hasOlderMessages ? (
              <div className="mb-4 flex justify-center">
                <button type="button" onClick={() => void loadConversation(true)} disabled={conversationLoading} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50">
                  {conversationLoading ? "Loading..." : "Load earlier messages"}
                </button>
              </div>
            ) : null}
            {conversationLoading && messages.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading conversation...
              </div>
            ) : messages.length === 0 && !conversationError ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted">
                  <MessageSquare className="size-5 text-muted-foreground" aria-hidden="true" />
                </div>
                <p className="text-sm font-medium">Start building your Android app</p>
                <p className="mt-1 text-xs text-muted-foreground">Your prompts and Mavly's actual responses will appear here.</p>
              </div>
            ) : (
              <ol className="space-y-5">
                {messages.map((message, index) => (
                  <li key={`${message.createdAt}-${message.author}-${message.messageType}-${index}`} className={`flex gap-2.5 ${message.author === "user" ? "flex-row-reverse" : ""}`}>
                    <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${message.author === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                      {message.author === "user" ? <User className="size-3.5" aria-hidden="true" /> : <Bot className="size-3.5" aria-hidden="true" />}
                    </span>
                    <div className={`min-w-0 max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${message.author === "user" ? "bg-muted text-foreground" : message.messageType === "error" || message.messageType === "limit-reached" ? "border border-destructive/25 bg-destructive/5 text-foreground" : "bg-transparent text-foreground"}`}>
                      <p className="whitespace-pre-wrap break-words">{message.message}</p>
                    </div>
                  </li>
                ))}
                {inFlight ? (
                  <li className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><Bot className="size-3.5" aria-hidden="true" /></span>
                    <div className="min-w-0 flex-1">
                      <RunProgress
                        elapsedMs={elapsedMs}
                        expectedMinutes={status?.expectedMinutes}
                        showEstimate={typeof status?.expectedMinutes === "number" && status.expectedMinutes > 0}
                      />
                      <PremiumAiActivity title={activityTitle} stages={activityStages} active={inFlight && !stageIsTerminal} />
                    </div>
                  </li>
                ) : null}
                <li aria-hidden="true" className="h-px list-none" />
              </ol>
            )}
            {conversationError ? (
              <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {conversationError}
              </p>
            ) : null}
            {statusError ? <p role="alert" className="mt-3 text-xs text-destructive">{statusError}</p> : null}
            {generationError ? (
              <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" /> {generationError}
              </p>
            ) : null}
            {status?.lastErrorClass ? <p className="mt-3 text-xs text-muted-foreground">Latest run error: {status.lastErrorClass}</p> : null}
          </div>

          <form
            className="shrink-0 border-t border-border bg-background p-3 sm:p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void startGeneration();
            }}
          >
            <div className="rounded-2xl border border-input bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/20">
              <label htmlFor="android-chat-prompt" className="sr-only">Message Mavly about your Android app</label>
              <textarea
                id="android-chat-prompt"
                ref={promptRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void startGeneration();
                  }
                }}
                rows={2}
                placeholder={inFlight ? "Mavly is generating..." : "Describe a screen, flow, or change..."}
                className="block max-h-40 min-h-16 w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
                disabled={starting || inFlight}
              />
              <div className="flex items-center justify-between px-2 pb-2">
                <span className="px-2 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
                <Button type="submit" size="icon" className="size-8 rounded-xl" disabled={!prompt.trim() || starting || inFlight} aria-label="Send prompt">
                  {starting || inFlight ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                </Button>
              </div>
            </div>
          </form>
        </section>

        <section
          aria-label={mobileView === "code" ? "Android Code Explorer" : mobileView === "more" ? "Android workspace More" : "Android app preview"}
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/40"
        >
          {mobileView === "preview" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-4 sm:px-8">
              <div
                className="relative flex aspect-[9/19.5] w-auto min-h-0 max-h-full max-w-[420px] flex-col overflow-hidden rounded-[2.8rem] border-[7px] border-neutral-800 bg-neutral-900 p-1.5 shadow-2xl ring-1 ring-black/10"
                style={{
                  height: "min(860px, calc(100% - 32px))",
                  maxWidth: "min(420px, calc(100% - 32px))",
                }}
              >
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2.2rem] bg-background">
                  <div className="flex h-8 shrink-0 items-center justify-center bg-background">
                    <span className="h-1.5 w-16 rounded-full bg-neutral-800" aria-hidden="true" />
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center border-y border-border bg-muted/30 px-5 text-center">
                    <div className="mb-4 flex size-16 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground shadow-sm">
                      <Smartphone className="size-8" aria-hidden="true" />
                    </div>
                    <p className="text-base font-semibold">Native preview unavailable</p>
                    <p className="mt-2 max-w-[280px] text-[13px] leading-relaxed text-muted-foreground">
                      This workspace has no Android emulator runtime. Mavly will not display a website preview as a native app.
                    </p>
                    {files?.length ? (
                      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setMobileView("code")}>
                        <Code2 className="mr-1.5 size-3.5" aria-hidden="true" /> View generated source
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex h-7 shrink-0 items-center justify-center bg-background">
                    <span className="h-1 w-20 rounded-full bg-neutral-800" aria-hidden="true" />
                  </div>
                </div>
              </div>
            </div>
          ) : mobileView === "code" ? (
            <div className="flex min-h-0 flex-1 flex-col bg-background">
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
                <div className="flex min-w-0 items-center gap-2">
                  <Code2 className="size-4 shrink-0 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">Code Explorer</h2>
                  {files?.length ? <span className="text-xs text-muted-foreground">{files.length} files</span> : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <Button type="button" variant="outline" size="icon" className="size-8" onClick={() => void loadFiles()} disabled={refreshing} aria-label="Refresh Android source">
                    <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                  </Button>
                  {files?.length ? (
                    <Button type="button" variant="outline" size="icon" className="size-8" onClick={() => void downloadSource()} disabled={downloading} aria-label="Download Android source">
                      {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <aside className="shrink-0 border-b border-border md:w-64 md:border-b-0 md:border-r">
                  <div className="border-b border-border p-2">
                    <label className="relative block">
                      <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={codeSearch}
                        onChange={(event) => setCodeSearch(event.target.value)}
                        placeholder="Search files"
                        className="h-8 w-full rounded-md border border-border bg-muted/30 pl-8 pr-2 text-xs outline-none focus:border-ring"
                        aria-label="Search source files"
                      />
                    </label>
                  </div>
                  <nav aria-label="Android source file tree" className="max-h-44 overflow-y-auto p-1.5 md:max-h-none md:h-[calc(100%-49px)]">
                    {filesError ? (
                      <div className="p-2"><p role="alert" className="text-xs text-destructive">{filesError}</p></div>
                    ) : files === null ? (
                      <p className="p-3 text-xs text-muted-foreground">Loading files...</p>
                    ) : files.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground">No Android source files have been saved yet.</p>
                    ) : codeTree.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground">No files match your search.</p>
                    ) : renderCodeTree(codeTree)}
                  </nav>
                </aside>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{selectedPath || "Select a source file"}</span>
                    {fileContent?.encoding === "utf8" && !contentLoading ? (
                      editing ? (
                        <>
                          <Button type="button" size="sm" className="h-7" onClick={() => void saveFile()} disabled={saving}>{saving ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}{saving ? "Saving" : "Save"}</Button>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => { setDraft(fileContent.content); setSaveError(null); setEditing(false); }} disabled={saving}>Cancel</Button>
                        </>
                      ) : (
                        <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => { setDraft(fileContent.content); setSaveError(null); setEditing(true); }}>Edit</Button>
                      )
                    ) : null}
                  </div>
                  {saveError ? <p role="alert" className="shrink-0 px-3 pt-2 text-xs text-destructive">{saveError}</p> : null}
                  <div className="min-h-0 flex-1">
                    {contentLoading ? (
                      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading file...</div>
                    ) : contentError ? (
                      <p role="alert" className="p-4 text-sm text-destructive">{contentError}</p>
                    ) : fileContent?.encoding === "base64" ? (
                      <p className="p-4 text-sm text-muted-foreground">This binary file is saved but cannot be displayed as source text.</p>
                    ) : fileContent ? (
                      <MonacoEditor
                        key={selectedPath ?? "android-source"}
                        height="100%"
                        language={androidLanguageFromPath(selectedPath ?? "")}
                        value={editing ? draft : fileContent.content}
                        onChange={(value) => editing && setDraft(value ?? "")}
                        beforeMount={silenceMonacoDiagnostics}
                        theme="light"
                        options={{ readOnly: !editing, minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", wordWrap: "off", scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 12, bottom: 12 } }}
                      />
                    ) : !filesError && files?.length ? (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to view its contents.</div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4 sm:p-6">
              <div className="mx-auto max-w-3xl">
                <div className="mb-5 flex items-center gap-2">
                  <LayoutGrid className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">More</h2>
                </div>
                <button type="button" onClick={() => setGithubOpen(true)} className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50">
                  <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-background"><GitBranch className="size-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">GitHub</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{githubConnected ? "Connected repository and branches" : "Connect, push, or import source"}</span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <Dialog open={buildsOpen} onOpenChange={setBuildsOpen}>
        <DialogContent className="flex h-[min(86dvh,760px)] w-[calc(100%-1rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Smartphone className="size-4" aria-hidden="true" /> Android build status
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {buildCapability?.build.reason ?? "Android build capability is unavailable."}
            </p>
            {buildCapability?.profile.applicationId ? (
              <p className="text-xs text-muted-foreground">
                Package <code className="font-mono">{buildCapability.profile.applicationId}</code>
                {" · "}{buildCapability.profile.toolchain}
              </p>
            ) : null}
            {buildCapability?.build.requirements.length ? (
              <ul className="list-inside list-disc text-xs text-muted-foreground">
                {buildCapability.build.requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}
              </ul>
            ) : null}
            {buildCapability?.build.warnings.length ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {buildCapability.build.warnings.join(" ")}
              </p>
            ) : null}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Debug APK</p>
                <p className="text-xs text-muted-foreground">
                  {buildCapability?.build.available
                    ? "Debug variant only. No release signing, AAB or store publishing."
                    : buildCapability?.build.reason ?? "Build capability is unavailable."}
                </p>
              </div>
              {buildCapability?.build.available ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void startBuild()}
                  disabled={buildStarting || Boolean(activeBuild)}
                >
                  {buildStarting || activeBuild ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" /> : null}
                  {activeBuild ? "Build in progress" : "Build debug APK"}
                </Button>
              ) : null}
            </div>
            {buildError ? <p role="alert" className="mt-3 text-xs text-destructive">{buildError}</p> : null}
            <div className="mt-5">
              <h3 className="text-sm font-medium">Build history</h3>
              {builds === null ? (
                <p className="mt-3 text-xs text-muted-foreground">Loading build history...</p>
              ) : builds.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">No Android build has been started.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {builds.slice(0, 5).map((build) => {
                    const active = build.state === "queued" || build.state === "running";
                    const succeeded = build.state === "succeeded";
                    const failed = build.state === "failed" ||
                      build.state === "timed_out" ||
                      build.state === "configuration_error" ||
                      build.state === "infrastructure_error";
                    const log = buildLogs[build.id];
                    return (
                      <li key={build.id} className="rounded-lg border border-border px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`min-w-0 flex-1 font-medium ${failed ? "text-destructive" : succeeded ? "text-emerald-700" : "text-foreground"}`}>
                            {build.state ?? build.status}
                            {build.stage ? ` · ${build.stage.replaceAll("_", " ")}` : ""}
                          </span>
                          <span className="text-muted-foreground">
                            attempt {build.attempt ?? 0}/{build.maxAttempts ?? 0}
                          </span>
                          {active ? (
                            <Button type="button" size="sm" variant="outline" onClick={() => void cancelBuild(build.id)}>
                              Cancel
                            </Button>
                          ) : null}
                          {succeeded && build.artifact ? (
                            <Button type="button" size="sm" onClick={() => void downloadArtifact(build.id)}>
                              <Download className="mr-1 size-3.5" aria-hidden="true" /> APK
                            </Button>
                          ) : null}
                          {build.hasLog ? (
                            <Button type="button" size="sm" variant="outline" onClick={() => void loadBuildLog(build.id)}>
                              Log
                            </Button>
                          ) : null}
                        </div>
                        {build.artifact ? (
                          <p className="mt-1 break-all text-muted-foreground">
                            {build.artifact.sizeBytes} bytes · sha256 {build.artifact.sha256?.slice(0, 16)}… · expires {build.artifact.expiresAt}
                          </p>
                        ) : null}
                        {build.error ? <p className="mt-1 text-destructive">{build.error.code}: {build.error.message}</p> : null}
                        {log ? (
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px] leading-relaxed">
                            {log.text || "No log output."}
                            {log.truncated ? "\n[log truncated]" : ""}
                          </pre>
                        ) : build.logExcerpt ? (
                          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px] leading-relaxed">
                            {build.logExcerpt}
                          </pre>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <GithubModal
        open={githubOpen}
        onOpenChange={setGithubOpen}
        projectId={project.projectId}
        onStatusChange={setGithubConnected}
        onProjectChanged={() => void loadFiles()}
      />
    </main>
  );
}
