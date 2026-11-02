"use client";

import React, { useState } from "react";
import {
  Archive,
  Bell,
  CheckCircle2,
  Eye,
  Megaphone,
  Pencil,
  PlusCircle,
  RefreshCw,
  Send,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import {
  ANNOUNCEMENT_KINDS,
  announcementKindLabel,
  announcementStatusLabel,
  isAnnouncementLive,
  type AdminAnnouncementRow,
  type AnnouncementKind,
  type AnnouncementStatus,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import {
  useAdminMutation,
  useAnnouncements,
  useDebouncedValue,
} from "../components/useAdminConsoleData";
import {
  Badge,
  DetailRow,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Modal,
  Pagination,
  PrimaryButton,
  SearchField,
  SecondaryButton,
  SectionCard,
  SegmentedFilter,
  StatCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ ANNOUNCEMENTS ══════════════════════════════════════════════════════════
 *
 * Every announcement here is a row in `public.admin_announcements`, written
 * through `admin_announcement_save`. The previous page rendered a hardcoded
 * array and its create form pushed into local state, so nothing it "published"
 * existed anywhere.
 *
 * ⚠️ PUBLISHED IS NOT DELIVERED. Publishing makes a row eligible for
 * `active_announcements()`. Mavly has no push, email or in-app banner consumer
 * wired to that feed, so the page reports publication state and says plainly
 * that no delivery channel exists. "Live" here means "published and inside its
 * visibility window", which is a statement about the row, not about a user
 * having seen it.
 *
 * ⚠️ DELETE IS REFUSED FOR A PUBLISHED ROW. It must be unpublished or archived
 * first, so removing something users can currently see is always two deliberate
 * steps with their own audit entries.
 */

const PAGE_SIZE = 20;

const KIND_ICON: Record<AnnouncementKind, React.ReactNode> = {
  information: <Bell className="w-3 h-3" />,
  success: <CheckCircle2 className="w-3 h-3" />,
  warning: <TriangleAlert className="w-3 h-3" />,
  maintenance: <Wrench className="w-3 h-3" />,
};

const KIND_TONE: Record<AnnouncementKind, "neutral" | "positive" | "warning" | "danger"> = {
  information: "neutral",
  success: "positive",
  warning: "warning",
  maintenance: "neutral",
};

const STATUS_TONE: Record<AnnouncementStatus, "positive" | "neutral" | "warning"> = {
  draft: "neutral",
  published: "positive",
  archived: "warning",
};

export default function AnnouncementsPage() {
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, loading, error, refresh } = useAnnouncements({
    status,
    kind,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  const [editing, setEditing] = useState<AdminAnnouncementRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<AdminAnnouncementRow | null>(null);

  const rows = data?.rows ?? [];
  const counts = data?.counts ?? null;

  return (
    <AdminShell activeNav="Announcements" live>
      {/* ── Counts ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard
          label="Live now"
          value={counts ? counts.live.toLocaleString() : null}
          hint="Published and inside its visibility window"
          icon={<Megaphone className="w-3.5 h-3.5 text-success" />}
          tone="positive"
          unavailable={!counts}
        />
        <StatCard
          label="Published"
          value={counts ? counts.published.toLocaleString() : null}
          hint="Eligible for the app feed"
          icon={<Send className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!counts}
        />
        <StatCard
          label="Drafts"
          value={counts ? counts.draft.toLocaleString() : null}
          hint="Not visible to anyone"
          icon={<Pencil className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!counts}
        />
        <StatCard
          label="Archived"
          value={counts ? counts.archived.toLocaleString() : null}
          hint="Retained, never served"
          icon={<Archive className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!counts}
        />
      </div>

      <UnavailableNote>
        Publishing makes an announcement eligible for the app feed, but Mavly has no push, email or
        in-app banner consumer wired to that feed yet. A published announcement is available to
        whatever reads the feed; it is not delivered to anyone by this action.
      </UnavailableNote>

      {/* ── List ──────────────────────────────────────────────────────────── */}
      <SectionCard
        title="Announcements"
        description="Operator-authored broadcasts, stored in the database."
        actions={
          <>
            <SecondaryButton
              icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />}
              onClick={refresh}
              disabled={loading}
            >
              Refresh
            </SecondaryButton>
            <PrimaryButton
              icon={<PlusCircle className="w-3.5 h-3.5" />}
              onClick={() => setCreating(true)}
            >
              New announcement
            </PrimaryButton>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedFilter
                options={[
                  { id: "all", label: "All" },
                  { id: "draft", label: "Draft" },
                  { id: "published", label: "Published" },
                  { id: "archived", label: "Archived" },
                ]}
                value={status}
                onChange={(next) => {
                  setStatus(next);
                  setPage(0);
                }}
              />
              <select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                  setPage(0);
                }}
                className="h-8 px-2.5 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)]"
              >
                <option value="all">All types</option>
                {ANNOUNCEMENT_KINDS.map((entry) => (
                  <option key={entry} value={entry}>
                    {announcementKindLabel(entry)}
                  </option>
                ))}
              </select>
            </div>
            <SearchField
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              placeholder="Search title, body, audience…"
            />
          </div>

          {loading && !data ? (
            <LoadingBlock label="Reading announcements" />
          ) : error && !data ? (
            <ErrorBlock message={error} onRetry={refresh} />
          ) : rows.length === 0 ? (
            <EmptyBlock
              title="No announcements match this view"
              detail={
                status === "all" && kind === "all" && debouncedSearch === ""
                  ? "Nothing has been written yet. Create one to publish it to the app feed."
                  : "Try a different filter or clear the search."
              }
            />
          ) : (
            <div className="space-y-2">
              {rows.map((row) => (
                <AnnouncementCard
                  key={row.id}
                  row={row}
                  onPreview={() => setPreviewing(row)}
                  onEdit={() => setEditing(row)}
                  onChanged={refresh}
                />
              ))}
            </div>
          )}

          {data && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={data.total}
              onPageChange={setPage}
              loading={loading}
            />
          )}

          {error && data && (
            <p className="text-[11px] text-warning-subtle-foreground">
              Showing the last successful read. The newest refresh failed: {error}
            </p>
          )}
        </div>
      </SectionCard>

      {(creating || editing) && (
        <AnnouncementForm
          row={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refresh();
          }}
        />
      )}

      {previewing && (
        <AnnouncementPreview row={previewing} onClose={() => setPreviewing(null)} />
      )}
    </AdminShell>
  );
}

// ─────────────────────────────── card ───────────────────────────────────────

function AnnouncementCard({
  row,
  onPreview,
  onEdit,
  onChanged,
}: {
  row: AdminAnnouncementRow;
  onPreview: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const mutation = useAdminMutation();
  const live = isAnnouncementLive(row);

  const save = async (nextStatus: AnnouncementStatus, message: string) => {
    const result = await mutation.run<{ message: string }>("/api/adminsh/announcements/save", {
      id: row.id,
      title: row.title,
      body: row.body,
      kind: row.kind,
      status: nextStatus,
      targetPlan: row.targetPlan,
      dismissible: row.dismissible,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
    });
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    toast.success(message);
    onChanged();
  };

  const remove = async () => {
    const result = await mutation.run<{ status: string }>("/api/adminsh/announcements/save", {
      id: row.id,
      status: "__delete__",
    });
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    toast.success("Announcement deleted.");
    onChanged();
  };

  return (
    <div className="px-3 py-3 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={KIND_TONE[row.kind]} icon={KIND_ICON[row.kind]}>
              {announcementKindLabel(row.kind)}
            </Badge>
            <Badge tone={STATUS_TONE[row.status]}>{announcementStatusLabel(row.status)}</Badge>
            {live && <Badge tone="positive">live now</Badge>}
            {row.status === "published" && !live && <Badge tone="warning">outside window</Badge>}
            <Badge tone="neutral">{row.targetPlan}</Badge>
          </div>
          <p className="text-xs font-semibold text-foreground mt-1.5">{row.title}</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2 mt-0.5">
            {row.body}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <SecondaryButton icon={<Eye className="w-3 h-3" />} onClick={onPreview}>
            Preview
          </SecondaryButton>
          <SecondaryButton icon={<Pencil className="w-3 h-3" />} onClick={onEdit}>
            Edit
          </SecondaryButton>
          {row.status !== "published" ? (
            <SecondaryButton
              icon={<Send className="w-3 h-3" />}
              onClick={() => save("published", "Published. It is now eligible for the app feed.")}
              disabled={mutation.pending}
            >
              Publish
            </SecondaryButton>
          ) : (
            <SecondaryButton
              icon={<Pencil className="w-3 h-3" />}
              onClick={() => save("draft", "Unpublished. It is no longer served.")}
              disabled={mutation.pending}
            >
              Unpublish
            </SecondaryButton>
          )}
          {row.status !== "archived" && (
            <SecondaryButton
              icon={<Archive className="w-3 h-3" />}
              onClick={() => save("archived", "Archived. It is retained but never served.")}
              disabled={mutation.pending}
            >
              Archive
            </SecondaryButton>
          )}
          <SecondaryButton
            icon={<Trash2 className="w-3 h-3" />}
            onClick={remove}
            disabled={mutation.pending || row.status === "published"}
            title={
              row.status === "published"
                ? "Unpublish or archive before deleting"
                : "Delete this announcement"
            }
          >
            Delete
          </SecondaryButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground font-mono">
        <span>created {formatTimestamp(row.createdAt)}</span>
        <span>updated {formatTimestamp(row.updatedAt)}</span>
        {row.publishedAt && <span>published {formatTimestamp(row.publishedAt)}</span>}
        {row.startsAt && <span>starts {formatTimestamp(row.startsAt)}</span>}
        {row.expiresAt && <span>expires {formatTimestamp(row.expiresAt)}</span>}
        <span>by {row.createdByEmail ?? "unknown"}</span>
      </div>

      {mutation.error && (
        <p className="text-[11px] text-warning-subtle-foreground">{mutation.error}</p>
      )}
    </div>
  );
}

// ─────────────────────────────── form ───────────────────────────────────────

function AnnouncementForm({
  row,
  onClose,
  onSaved,
}: {
  row: AdminAnnouncementRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(row?.title ?? "");
  const [body, setBody] = useState(row?.body ?? "");
  const [kind, setKind] = useState<AnnouncementKind>(row?.kind ?? "information");
  const [status, setStatus] = useState<AnnouncementStatus>(row?.status ?? "draft");
  const [targetPlan, setTargetPlan] = useState(row?.targetPlan ?? "All Plans");
  const [dismissible, setDismissible] = useState(row?.dismissible ?? true);
  const [startsAt, setStartsAt] = useState(toLocalInput(row?.startsAt ?? null));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(row?.expiresAt ?? null));

  const mutation = useAdminMutation();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await mutation.run<{ message: string }>("/api/adminsh/announcements/save", {
      id: row?.id ?? null,
      title,
      body,
      kind,
      status,
      targetPlan,
      dismissible,
      startsAt: fromLocalInput(startsAt),
      expiresAt: fromLocalInput(expiresAt),
    });
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    toast.success(result.data.message);
    onSaved();
  };

  return (
    <Modal
      title={row ? "Edit announcement" : "New announcement"}
      icon={<Megaphone className="w-4 h-4 text-foreground" />}
      onClose={onClose}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-3.5 text-xs">
        <div>
          <label className="block font-semibold text-foreground mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            required
            className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            placeholder="Scheduled maintenance on Saturday"
          />
        </div>

        <div>
          <label className="block font-semibold text-foreground mb-1">Body</label>
          <textarea
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={4000}
            required
            className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            placeholder="What is changing, when, and what the reader should do."
          />
          <p className="text-[10px] text-muted-foreground mt-1">{body.length} / 4000</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-semibold text-foreground mb-1">Type</label>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as AnnouncementKind)}
              className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            >
              {ANNOUNCEMENT_KINDS.map((entry) => (
                <option key={entry} value={entry}>
                  {announcementKindLabel(entry)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-semibold text-foreground mb-1">Status</label>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as AnnouncementStatus)}
              className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block font-semibold text-foreground mb-1">Audience label</label>
          <input
            type="text"
            value={targetPlan}
            onChange={(event) => setTargetPlan(event.target.value)}
            maxLength={80}
            className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            placeholder="All Plans"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            A label for readers. It does not filter who receives the announcement.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-semibold text-foreground mb-1">Starts (optional)</label>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            />
          </div>
          <div>
            <label className="block font-semibold text-foreground mb-1">Expires (optional)</label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-[11px] text-foreground">
          <input
            type="checkbox"
            checked={dismissible}
            onChange={(event) => setDismissible(event.target.checked)}
            className="rounded border-[var(--clay-line)]"
          />
          Readers may dismiss this announcement
        </label>

        {mutation.error && (
          <p className="text-[11px] text-warning-subtle-foreground">{mutation.error}</p>
        )}

        <div className="pt-2 flex items-center justify-end gap-2 border-t border-[var(--clay-line)]">
          <SecondaryButton onClick={onClose} disabled={mutation.pending}>
            Cancel
          </SecondaryButton>
          <PrimaryButton type="submit" disabled={mutation.pending}>
            {mutation.pending ? "Saving…" : row ? "Save changes" : "Create announcement"}
          </PrimaryButton>
        </div>

        {status === "published" && (
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Publishing makes this eligible for the app feed immediately (or at the start time).
            No delivery channel is wired to the feed, so this does not notify anyone.
          </p>
        )}
      </form>
    </Modal>
  );
}

// ────────────────────────────── preview ─────────────────────────────────────

function AnnouncementPreview({
  row,
  onClose,
}: {
  row: AdminAnnouncementRow;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Preview"
      icon={<Eye className="w-4 h-4 text-foreground" />}
      onClose={onClose}
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5">{KIND_ICON[row.kind]}</span>
            <div className="min-w-0">
              <p className="text-xs font-bold text-foreground">{row.title}</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-1 whitespace-pre-wrap">
                {row.body}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs">
          <DetailRow label="Status" value={announcementStatusLabel(row.status)} />
          <DetailRow label="Live now" value={isAnnouncementLive(row) ? "yes" : "no"} />
          <DetailRow label="Type" value={announcementKindLabel(row.kind)} />
          <DetailRow label="Audience" value={row.targetPlan} />
          <DetailRow label="Dismissible" value={row.dismissible ? "yes" : "no"} />
          <DetailRow label="Starts" value={formatTimestamp(row.startsAt)} />
          <DetailRow label="Expires" value={formatTimestamp(row.expiresAt)} />
          <DetailRow label="Created by" value={row.createdByEmail} />
          <DetailRow label="Created" value={formatTimestamp(row.createdAt)} />
          <DetailRow label="Updated" value={formatTimestamp(row.updatedAt)} />
        </div>

        <div className="pt-2 flex justify-end border-t border-[var(--clay-line)]">
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────── datetime helpers ───────────────────────────────

/** ISO → the value a `datetime-local` input expects, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** `datetime-local` value → ISO, or null when the field is empty. */
function fromLocalInput(value: string): string | null {
  if (value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}
