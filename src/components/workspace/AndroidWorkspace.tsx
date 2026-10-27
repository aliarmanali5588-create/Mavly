"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Code2, Download, FileCode2, Loader2, RefreshCw, Send, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { vcaasApi } from "@/lib/vcaas";
import type { AgentStatus, FileContent, FileTreeEntry, VcaasProject } from "@/lib/vcaas-types";

export function AndroidWorkspace({ project }: { project: VcaasProject }) {
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
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const contentRequest = useRef(0);
  const completedRun = useRef<string | null>(null);

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

  const refreshStatus = useCallback(async () => {
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
  }, [loadFiles, project.projectId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const inFlight = status?.status === "init";
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => void refreshStatus(), 3_500);
    return () => window.clearInterval(timer);
  }, [inFlight, refreshStatus]);

  const startGeneration = async () => {
    const text = prompt.trim();
    if (!text || starting || inFlight) return;
    setStarting(true);
    setGenerationError(null);
    const response = await vcaasApi.agent.start(project.projectId, {
      prompt: text,
      inputFiles: [],
    });
    setStarting(false);
    if (!response.ok) {
      setGenerationError(response.error || "Could not start Android source generation.");
      return;
    }
    setPrompt("");
    await refreshStatus();
  };

  const saveFile = async () => {
    if (!selectedPath || saving) return;
    setSaving(true);
    setSaveError(null);
    const response = await vcaasApi.files.write(project.projectId, selectedPath, draft);
    setSaving(false);
    if (!response.ok) {
      setSaveError(response.error || "Could not save this source file.");
      return;
    }
    setEditing(false);
    setFileContent((current) => (current ? { ...current, content: draft } : current));
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

  return (
    <main className="min-h-screen bg-[#fcfbf8] text-gray-900">
      <header className="sticky top-0 z-10 border-b border-black/[0.06] bg-[#fcfbf8]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            My projects
          </Link>
          <span className="flex items-center gap-2 text-sm font-medium text-gray-800">
            <Smartphone className="h-4 w-4" aria-hidden="true" />
            Android Workspace
          </span>
          <div className="flex items-center gap-2">
            {files && files.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void downloadSource()} disabled={downloading}>
                {downloading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
                <span className="hidden sm:inline">Download source</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void loadFiles()} disabled={refreshing}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
              <span className="hidden sm:inline">Refresh files</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <section className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)] sm:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-black/[0.06] bg-[#f7f6f3]">
              <Smartphone className="h-5 w-5 text-gray-600" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight">{projectName}</h1>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">Android app</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">{project.projectId}</p>
              {project.description && (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-600">{project.description}</p>
              )}
            </div>
          </div>
        </section>

        <section
          aria-labelledby="android-capability-title"
          className="rounded-2xl border border-amber-200 bg-amber-50/80 p-5 sm:p-6"
        >
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div>
              <h2 id="android-capability-title" className="font-semibold text-amber-950">
                Kotlin/Compose source only — no APK/AAB build
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-amber-900/80">
                Mavly generates and validates native Kotlin and Jetpack Compose source. This deployment has no isolated Android build executor, so no APK or AAB is built, signed or installed, and there is no emulator preview.
              </p>
              <p className="mt-2 text-xs text-amber-900/70">
                {project.android?.build.reason ??
                  "No isolated Android build executor or artifact storage is configured in this deployment."}
              </p>
              {project.android?.profile.applicationId ? (
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-amber-900/80">
                  <dt className="font-medium">Package</dt>
                  <dd className="truncate font-mono">{project.android.profile.applicationId}</dd>
                  <dt className="font-medium">API</dt>
                  <dd>min {project.android.profile.minSdk} / target {project.android.profile.targetSdk}</dd>
                  <dt className="font-medium">Toolchain</dt>
                  <dd>{project.android.profile.toolchain}</dd>
                </dl>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)] sm:p-6">
          <h2 className="text-sm font-semibold text-gray-800">Generate or update the Android app</h2>
          <p className="mt-1 text-xs text-gray-400">
            Describe the screen, flow or change. Mavly updates the saved Kotlin/Compose source; it does not build an APK.
          </p>
          <label className="mt-3 block">
            <span className="sr-only">Android prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="Describe the Android app or the change you want..."
              className="w-full resize-y rounded-xl border border-black/[0.08] bg-[#fcfbf8] px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-300 focus:ring-2 focus:ring-gray-200"
              disabled={starting || inFlight}
            />
          </label>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-gray-400">
              {inFlight
                ? `Generating${status?.stage ? ` · ${status.stage}` : ""}...`
                : status?.status === "done"
                  ? "Last generation finished."
                  : "Ready."}
            </span>
            <Button onClick={() => void startGeneration()} disabled={!prompt.trim() || starting || inFlight}>
              {starting || inFlight ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              {inFlight ? "Generating" : "Generate"}
            </Button>
          </div>
          {statusError ? <p role="alert" className="mt-2 text-xs text-red-600">{statusError}</p> : null}
          {generationError ? <p role="alert" className="mt-2 text-xs text-red-600">{generationError}</p> : null}
          {status?.lastErrorClass ? <p className="mt-2 text-xs text-amber-700">Last error: {status.lastErrorClass}</p> : null}
          {status?.realtimeConversation && status.realtimeConversation.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {status.realtimeConversation.map((message, index) => (
                <li key={`${message.createdAt}-${index}`} className="rounded-xl bg-[#f7f6f3] px-3 py-2 text-xs text-gray-600">
                  <span className="mr-2 font-medium text-gray-500">{message.author === "user" ? "You" : "Mavly"}</span>
                  <span className="whitespace-pre-wrap">{message.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2 border-b border-black/[0.06] px-4 py-3 sm:px-5">
            <Code2 className="h-4 w-4 text-gray-500" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-gray-800">Saved source files</h2>
            <span className="text-xs text-gray-400">{files ? `${files.length}` : ""}</span>
          </div>

          {filesError ? (
            <div className="p-5">
              <p role="alert" className="text-sm text-red-600">{filesError}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void loadFiles()} disabled={refreshing}>
                Try again
              </Button>
            </div>
          ) : files === null ? (
            <p className="p-5 text-sm text-gray-500">Loading saved files...</p>
          ) : files.length === 0 ? (
            <div className="p-8 text-center">
              <FileCode2 className="mx-auto h-7 w-7 text-gray-300" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-gray-600">No Android source files are saved yet.</p>
              <p className="mt-1 text-xs text-gray-400">Describe the app above and Mavly will generate the Kotlin/Compose source.</p>
            </div>
          ) : (
            <div className="grid min-h-[360px] md:grid-cols-[minmax(190px,0.35fr)_1fr]">
              <nav aria-label="Saved source files" className="max-h-[420px] overflow-y-auto border-b border-black/[0.06] p-2 md:border-b-0 md:border-r">
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedPath(file.path)}
                    aria-current={selectedPath === file.path ? "page" : undefined}
                    className={`block w-full truncate rounded-lg px-3 py-2 text-left font-mono text-xs ${
                      selectedPath === file.path ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
                    }`}
                    title={file.path}
                  >
                    {file.path}
                  </button>
                ))}
              </nav>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.04] px-4 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-500">
                    {selectedPath || "Select a file"}
                  </span>
                  {fileContent?.encoding === "utf8" && !contentLoading ? (
                    editing ? (
                      <>
                        <Button size="sm" onClick={() => void saveFile()} disabled={saving}>
                          {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (fileContent) setDraft(fileContent.content);
                            setSaveError(null);
                            setEditing(false);
                          }}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (fileContent) setDraft(fileContent.content);
                          setSaveError(null);
                          setEditing(true);
                        }}
                      >
                        Edit
                      </Button>
                    )
                  ) : null}
                </div>
                {saveError ? <p role="alert" className="px-4 pt-3 text-sm text-red-600">{saveError}</p> : null}
                {contentLoading ? (
                  <p className="p-4 text-sm text-gray-500">Loading file...</p>
                ) : contentError ? (
                  <p role="alert" className="p-4 text-sm text-red-600">{contentError}</p>
                ) : fileContent?.encoding === "base64" ? (
                  <p className="p-4 text-sm text-gray-500">This binary file is saved but cannot be displayed as source text.</p>
                ) : editing ? (
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    spellCheck={false}
                    className="block h-[600px] w-full resize-none bg-white p-4 font-mono text-xs leading-relaxed text-gray-700 outline-none"
                    aria-label={`Edit ${selectedPath ?? "source file"}`}
                  />
                ) : fileContent ? (
                  <pre className="max-h-[600px] overflow-auto p-4 text-xs leading-relaxed text-gray-700">
                    <code>{fileContent.content}</code>
                  </pre>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
