"use client";

import * as React from "react";
import {
  Eye,
  Code2,
  LayoutGrid,
  Clock,
  Copy,
  Server,
  FolderOpen,
  Plus,
  Sparkles,
  RefreshCw,
  Github,
  Figma,
  ChevronRight,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

/**
 * ═══ THE MOBILE WORKSPACE MENU ═══════════════════════════════════════════════
 *
 * A clay bottom sheet holding the workspace actions that do not fit in a 44px
 * phone header. Every entry here is an action the desktop workspace already
 * owns — this component calls the page's own handlers and never reimplements
 * one. Nothing is listed that does not exist: there is no "Project Settings"
 * and no "File Browser" in this workspace, so neither appears here.
 *
 * The sheet is a sibling of the page's dialogs, not a replacement for them:
 * picking "Versions" closes the sheet and opens the same `VersionsModal` the
 * desktop header's clock button opens.
 */

export interface MobileWorkspaceMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project's own label, shown as the sheet's subtitle. */
  projectName: string;
  /** Which panel tab is currently showing, so the view group can mark it. */
  activeTab: string;
  onSelectTab: (id: string) => void;
  onOpenVersions: () => void;
  onDuplicate: () => void;
  onRestartServer: () => void;
  onRefreshPreview: () => void;
  onOpenGithub: () => void;
  onOpenFigma: () => void;
  onNavigate: (href: string) => void;
  githubConnected: boolean;
  figmaConnected: boolean;
}

type RowProps = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail?: string;
  active?: boolean;
  onClick: () => void;
  /** A small live dot for a connection that is already established. */
  connected?: boolean;
};

function MenuRow({ icon: Icon, label, detail, active, onClick, connected }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-[box-shadow,background-color,color] duration-200 ${
        active
          ? "bg-[var(--clay-sunken)] shadow-[var(--clay-well-2)] text-foreground font-semibold"
          : "text-foreground hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-1)]"
      }`}
    >
      <span className="relative flex items-center shrink-0">
        <Icon className="w-[18px] h-[18px] text-muted-foreground" />
        {connected && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-success ring-2 ring-[var(--clay-surface)]" />
        )}
      </span>
      <span className="flex-1 min-w-0 text-sm truncate">{label}</span>
      {detail && (
        <span className="text-[11px] text-muted-foreground shrink-0">{detail}</span>
      )}
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2">
      <p className="px-3 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function MobileWorkspaceMenu({
  open,
  onOpenChange,
  projectName,
  activeTab,
  onSelectTab,
  onOpenVersions,
  onDuplicate,
  onRestartServer,
  onRefreshPreview,
  onOpenGithub,
  onOpenFigma,
  onNavigate,
  githubConnected,
  figmaConnected,
}: MobileWorkspaceMenuProps) {
  /**
   * Every row closes the sheet first and then acts, so the action's own dialog
   * is never fighting the sheet for the same focus trap.
   */
  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-3xl border-t border-[var(--clay-line)] bg-card p-0 gap-0 max-h-[82dvh] flex flex-col"
      >
        <SheetHeader className="shrink-0 px-5 pr-12 pt-3 pb-3 border-b border-[var(--clay-line)]">
          {/* The grab handle: this is a sheet, and it says so. */}
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--clay-line-strong)]" />
          <SheetTitle className="text-base font-bold tracking-tight text-foreground text-left">
            Workspace
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground text-left truncate">
            {projectName}
          </SheetDescription>
        </SheetHeader>

        {/* Long menus scroll inside the sheet; the header stays put. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1">
          <Group title="Workspace view">
            <MenuRow
              icon={Eye}
              label="Preview"
              active={activeTab === "preview"}
              onClick={run(() => onSelectTab("preview"))}
            />
            <MenuRow
              icon={Code2}
              label="Code Explorer"
              active={activeTab === "code"}
              onClick={run(() => onSelectTab("code"))}
            />
            <MenuRow
              icon={LayoutGrid}
              label="Project overview"
              active={activeTab === "more"}
              onClick={run(() => onSelectTab("more"))}
            />
          </Group>

          <div className="mx-5 my-2 clay-divider" />

          <Group title="Preview">
            <MenuRow
              icon={RefreshCw}
              label="Refresh preview"
              onClick={run(onRefreshPreview)}
            />
          </Group>

          <div className="mx-5 my-2 clay-divider" />

          <Group title="Project">
            <MenuRow icon={Clock} label="Build history" onClick={run(onOpenVersions)} />
            <MenuRow icon={Copy} label="Duplicate project" onClick={run(onDuplicate)} />
            <MenuRow
              icon={Github}
              label="GitHub"
              detail={githubConnected ? "Connected" : undefined}
              connected={githubConnected}
              onClick={run(onOpenGithub)}
            />
            <MenuRow
              icon={Figma}
              label="Figma"
              detail={figmaConnected ? "Connected" : undefined}
              connected={figmaConnected}
              onClick={run(onOpenFigma)}
            />
          </Group>

          <div className="mx-5 my-2 clay-divider" />

          <Group title="Account">
            <MenuRow
              icon={FolderOpen}
              label="My projects"
              onClick={run(() => onNavigate("/dashboard"))}
            />
            <MenuRow
              icon={Plus}
              label="New project"
              onClick={run(() => onNavigate("/dashboard"))}
            />
            <MenuRow
              icon={Sparkles}
              label="Upgrade plan"
              onClick={run(() => onNavigate("/upgrade"))}
            />
            <MenuRow
              icon={Sparkles}
              label="Top up credits"
              onClick={run(() => onNavigate("/credit-topup"))}
            />
          </Group>

          <div className="mx-5 my-2 clay-divider" />

          <Group title="Server">
            <MenuRow
              icon={Server}
              label="Restart agent server"
              onClick={run(onRestartServer)}
            />
          </Group>
        </div>

        {/* Safe area under the last row, so a home indicator never covers it. */}
        <div
          aria-hidden
          className="shrink-0"
          style={{ height: "env(safe-area-inset-bottom)" }}
        />
      </SheetContent>
    </Sheet>
  );
}
