"use client";

import * as React from "react";
import {
    CheckCircle2Icon,
    ExternalLinkIcon,
    GithubIcon,
    LoaderIcon,
    PlusIcon,
    TriangleAlertIcon,
    UploadIcon,
    DownloadIcon,
} from "lucide-react";

import { ConfirmDialog, Modal, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { isSafeBranchName, isSafeRepoName } from "@/lib/integrations/github/safety";
import { toast } from "@/lib/toast";
import {
    githubApi,
    type GithubBranchSummary,
    type GithubImportPlan,
    type GithubRepositorySummary,
    type GithubStatus,
} from "@/lib/github-client";

/**
 * ═══ THE GITHUB DIALOG ═════════════════════════════════════════════════════
 *
 * It is the workspace's one GitHub surface: authorize the account, choose the
 * repository and the branch, push the project's source, import a branch's
 * source, and detach the repository.
 *
 * ⚠️ THERE IS NO TOKEN FIELD, AND THERE IS NEVER GOING TO BE ONE. The account
 * is authorized in GitHub's own screen; Mavly receives a token it stores
 * encrypted on the server, and the browser never holds it. The old dialog
 * asked people to mint a personal access token and paste it into a text box —
 * that whole flow is gone.
 *
 * ⚠️ A PUSH IS NEVER FORCED. When the branch moved on GitHub, the dialog says
 * so and asks the user to confirm committing on top of it. The history of a
 * shared branch is never rewritten.
 *
 * ⚠️ AN IMPORT SHOWS ITS PLAN FIRST. The project's source is only replaced
 * after the user has seen what would change — and the current source is saved
 * as a recovery point before anything is written.
 */
export interface GithubModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
    /** Lets the workspace header show the connected dot. */
    onStatusChange: (connected: boolean) => void;
    /**
     * The project's source changed on the server (an import). The workspace
     * re-reads the project, the conversation and the preview.
     */
    onProjectChanged?: () => void;
}

export function GithubModal({
    open,
    onOpenChange,
    projectId,
    onStatusChange,
    onProjectChanged,
}: GithubModalProps) {
    const t = useT();

    type GithubSetupMode = "create" | "connect";

    const [mode, setMode] = React.useState<GithubSetupMode>("connect");
    const [status, setStatus] = React.useState<GithubStatus | null>(null);
    const [repositories, setRepositories] = React.useState<GithubRepositorySummary[] | null>(null);
    const [repositorySelection, setRepositorySelection] = React.useState<"all" | "selected" | null>(null);
    const [installationUrl, setInstallationUrl] = React.useState<string | null>(null);
    const [branches, setBranches] = React.useState<GithubBranchSummary[] | null>(null);
    const [selectedRepository, setSelectedRepository] = React.useState<string>("");
    const [selectedBranch, setSelectedBranch] = React.useState<string>("");
    const [repositoryEmpty, setRepositoryEmpty] = React.useState(false);

    const [newRepositoryName, setNewRepositoryName] = React.useState("");
    const [newRepositoryVisibility, setNewRepositoryVisibility] = React.useState<"public" | "private">("public");
    const [newRepositoryDescription, setNewRepositoryDescription] = React.useState("");

    const [repositoryLoading, setRepositoryLoading] = React.useState(false);
    const [repositoryError, setRepositoryError] = React.useState<string | null>(null);
    const [branchLoading, setBranchLoading] = React.useState(false);
    const [branchError, setBranchError] = React.useState<string | null>(null);
    const [repositoryReloadKey, setRepositoryReloadKey] = React.useState(0);
    const [branchReloadKey, setBranchReloadKey] = React.useState(0);

    const [loading, setLoading] = React.useState(false);
    const [authorizing, setAuthorizing] = React.useState(false);
    const [connecting, setConnecting] = React.useState(false);
    const [creating, setCreating] = React.useState(false);
    const [pushing, setPushing] = React.useState(false);
    const [importing, setImporting] = React.useState(false);
    const [disconnecting, setDisconnecting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    /** The repository this dialog just created, for the first-push status line. */
    const [createdRepository, setCreatedRepository] = React.useState<string | null>(null);

    const [importPlan, setImportPlan] = React.useState<GithubImportPlan | null>(null);
    const [conflictOpen, setConflictOpen] = React.useState(false);

    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const accountConnected = !!status?.connected;
    const connection = status?.connection ?? null;

    const loadStatus = React.useCallback(async () => {
        setLoading(true);
        const response = await githubApi.status(projectId);
        if (!mounted.current) return;
        setLoading(false);

        if (response.ok && response.data) {
            setStatus(response.data);
            onStatusChange(!!response.data.connection);
        } else {
            setStatus(null);
            onStatusChange(false);
            if (response.code === "GITHUB_INTEGRATION_NOT_CONFIGURED") {
                setError(t("workspace.github.notConfigured"));
            } else if (response.code === "GITHUB_UNAUTHORIZED") {
                /**
                 * ⭐ THE AUTHORIZATION EXPIRED OR WAS REVOKED. The dialog falls
                 * back to the "Connect GitHub" button, so the user can authorize
                 * again without anything else having to change.
                 */
                setError(t("workspace.github.reauthorize"));
            }
        }
    }, [projectId, onStatusChange, t]);

    React.useEffect(() => {
        if (!open) return;
        void loadStatus();
    }, [open, loadStatus]);

    /**
     * Clear per-repository selection when the dialog closes. The next opening
     * re-reads GitHub, so a repository created after the last visit (including
     * a new empty one) appears without a page reload.
     */
    React.useEffect(() => {
        if (open) return;
        setMode("connect");
        setRepositories(null);
        setRepositorySelection(null);
        setInstallationUrl(null);
        setBranches(null);
        setSelectedRepository("");
        setSelectedBranch("");
        setRepositoryEmpty(false);
        setNewRepositoryName("");
        setNewRepositoryVisibility("public");
        setNewRepositoryDescription("");
        setRepositoryLoading(false);
        setRepositoryError(null);
        setBranchLoading(false);
        setBranchError(null);
        setCreating(false);
        setCreatedRepository(null);
        setError(null);
    }, [open]);

    /**
     * The repository list is fetched once per opening, after the account is
     * authorized. A failed live call leaves the list unusable until the user
     * retries; it is never treated as "no repositories".
     */
    React.useEffect(() => {
        if (!open || !accountConnected || repositories !== null) return;

        let cancelled = false;
        setRepositoryLoading(true);
        setRepositoryError(null);

        void (async () => {
            const response = await githubApi.repositories();
            if (cancelled || !mounted.current) return;
            setRepositoryLoading(false);
            if (response.ok && response.data) {
                setRepositories(response.data.repositories);
                setRepositorySelection(response.data.repositorySelection);
                setInstallationUrl(response.data.installationUrl);
                return;
            }
            setRepositorySelection(null);
            setInstallationUrl(response.details?.installationUrl ?? null);
            setRepositoryError(response.error || t("workspace.github.repositoriesFailed"));
        })();

        return () => {
            cancelled = true;
        };
    }, [open, accountConnected, repositories, repositoryReloadKey, t]);

    /**
     * ⭐ NO REPOSITORIES YET? START ON "CREATE". A brand-new account should not
     * have to discover that the connect list is empty before it can get going.
     * The switch stays available; this only chooses the first mode.
     */
    React.useEffect(() => {
        if (!open || connection || !repositories) return;
        if (repositories.length === 0 && repositorySelection !== "selected") {
            setMode("create");
        }
    }, [open, connection, repositories, repositorySelection]);

    /** The branches of the selected repository. */
    React.useEffect(() => {
        if (!open || !selectedRepository) {
            setBranches(null);
            setSelectedBranch("");
            setRepositoryEmpty(false);
            setBranchLoading(false);
            setBranchError(null);
            return;
        }

        const repository = repositories?.find(entry => String(entry.id) === selectedRepository);
        if (!repository) return;

        let cancelled = false;
        setBranches(null);
        setSelectedBranch("");
        setRepositoryEmpty(false);
        setBranchLoading(true);
        setBranchError(null);

        void (async () => {
            const response = await githubApi.branches(repository.owner, repository.name);
            if (cancelled || !mounted.current) return;
            setBranchLoading(false);

            if (!response.ok || !response.data) {
                setBranches(null);
                setBranchError(response.error || t("workspace.github.branchesFailed"));
                return;
            }

            setBranches(response.data.branches);
            setRepositoryEmpty(response.data.empty === true);

            if (response.data.empty) {
                /**
                 * An empty repository has no branch to choose. Offer the
                 * intended first branch instead; the first successful push
                 * creates it. `main` is a default, not a claim that it exists.
                 */
                setSelectedBranch("main");
                return;
            }

            const preferred =
                response.data.defaultBranch ??
                repository.defaultBranch;
            setSelectedBranch(
                response.data.branches.find(branch => branch.name === preferred)?.name ??
                response.data.branches[0]?.name ??
                "",
            );
        })();

        return () => {
            cancelled = true;
        };
    }, [open, selectedRepository, repositories, branchReloadKey, t]);

    async function handleAuthorize() {
        if (authorizing) return;
        setAuthorizing(true);
        setError(null);
        setInstallationUrl(null);

        const response = await githubApi.start(
            typeof window !== "undefined" ? window.location.pathname : "/dashboard",
        );
        setAuthorizing(false);

        if (!response.ok || !response.data) {
            setError(response.error || t("workspace.github.connectRepositoryFailed"));
            return;
        }
        // The browser leaves for GitHub's own authorization screen.
        window.location.href = response.data.authorizationUrl;
    }

    async function handleCreateRepository(event?: React.FormEvent<HTMLFormElement>) {
        event?.preventDefault();
        if (creating) return;

        const name = newRepositoryName.trim();
        if (!isSafeRepoName(name)) {
            setError(t("workspace.github.repositoryNameInvalid"));
            return;
        }

        setCreating(true);
        setError(null);
        setInstallationUrl(null);

        const response = await githubApi.createRepository(projectId, {
            name,
            private: newRepositoryVisibility === "private",
            description: newRepositoryDescription.trim() || undefined,
        });
        setCreating(false);

        if (!response.ok) {
            const base =
                response.code === "GITHUB_REPOSITORY_EXISTS"
                    ? t("workspace.github.repositoryNameTaken")
                    : response.code === "GITHUB_NO_WRITE_PERMISSION"
                      ? t("workspace.github.createRepositoryPermission")
                      : response.error || t("workspace.github.createRepositoryFailed");
            const upstream = response.details?.message;
            setInstallationUrl(response.details?.installationUrl ?? null);
            setError(upstream ? `${base} (${upstream})` : base);
            return;
        }

        const createdConnection = response.data?.connection;
        setCreatedRepository(createdConnection?.repositoryFullName ?? null);
        setNewRepositoryName("");
        setNewRepositoryVisibility("public");
        setNewRepositoryDescription("");
        /**
         * The list was read before this repository existed. Clear it so the
         * next "Connect" view reads GitHub again instead of offering a stale
         * list that is missing the repository just created.
         */
        setRepositories(null);
        setSelectedRepository("");

        toast.success(
            createdConnection?.firstPushPending
                ? t("workspace.github.repositoryCreatedFirstPush", {
                      branch: createdConnection.branch,
                  })
                : t("workspace.github.repositoryCreated"),
        );
        await loadStatus();
    }

    async function handleConnect() {
        const repository = repositories?.find(entry => String(entry.id) === selectedRepository);
        const branchName = selectedBranch.trim();
        const branchValid = repositoryEmpty
            ? isSafeBranchName(branchName)
            : !!branches?.some(branch => branch.name === branchName);
        if (!repository || !branchName || !branchValid || branchLoading || branchError || connecting) return;

        setConnecting(true);
        setError(null);
        setInstallationUrl(null);

        const response = await githubApi.connect(projectId, {
            repositoryId: repository.id,
            owner: repository.owner,
            repository: repository.name,
            branch: branchName,
        });
        setConnecting(false);

        if (!response.ok) {
            setError(response.error || t("workspace.github.connectRepositoryFailed"));
            return;
        }
        const pendingConnection = response.data?.connection;
        setCreatedRepository(null);
        toast.success(
            pendingConnection?.firstPushPending
                ? t("workspace.github.repositoryConnectedFirstPush", {
                      branch: pendingConnection.branch,
                  })
                : t("workspace.github.repositoryConnected"),
        );
        await loadStatus();
    }

    async function handlePush(allowRemoteAdvance = false) {
        if (pushing) return;
        setPushing(true);
        setError(null);
        setInstallationUrl(null);

        const response = await githubApi.push(projectId, { allowRemoteAdvance });
        setPushing(false);
        setConflictOpen(false);

        if (!response.ok) {
            /**
             * ⚠️ THE BRANCH MOVED. Nothing was overwritten: the push was refused
             * before a single commit was created. The user is asked, separately,
             * whether to commit on top of the new head.
             */
            if (response.code === "GITHUB_CONFLICT") {
                setConflictOpen(true);
                return;
            }
            setError(response.error || t("workspace.github.pushFailed"));
            return;
        }

        if (response.data?.unchanged) {
            toast.info(t("workspace.github.pushNothing"));
        } else {
            toast.success(t("workspace.github.pushSucceeded"), {
                description: response.data?.commitSha?.slice(0, 7),
            });
        }
        await loadStatus();
    }

    async function handleImportPlan() {
        if (importing) return;
        setImporting(true);
        setError(null);
        setInstallationUrl(null);

        const response = await githubApi.import(projectId, false);
        setImporting(false);

        if (!response.ok || !response.data) {
            setError(response.error || t("workspace.github.importFailed"));
            return;
        }
        setImportPlan(response.data);
    }

    async function handleImportConfirm() {
        if (!importPlan || importing) return;
        setImporting(true);

        const response = await githubApi.import(projectId, true);
        setImporting(false);

        if (!response.ok) {
            setImportPlan(null);
            setError(response.error || t("workspace.github.importFailed"));
            return;
        }
        setImportPlan(null);
        toast.success(t("workspace.github.importSucceeded"));
        await loadStatus();
        onProjectChanged?.();
    }

    /**
     * ⭐ DISCONNECT THE GITHUB ACCOUNT. The token is revoked at GitHub and the
     * stored connection is deleted. The project's source and its recovery
     * points are not touched.
     */
    async function handleDisconnectAccount() {
        if (disconnecting) return;
        setDisconnecting(true);
        setError(null);
        setInstallationUrl(null);

        const response = await githubApi.disconnectAccount();
        setDisconnecting(false);

        if (!response.ok) {
            setError(response.error || t("workspace.github.disconnectFailed"));
            return;
        }
        toast.success(t("workspace.github.accountDisconnected"));
        setStatus(null);
        setRepositories(null);
        setBranches(null);
        setCreatedRepository(null);
        onStatusChange(false);
        await loadStatus();
    }

    async function handleDisconnect() {
        if (disconnecting) return;
        setDisconnecting(true);
        setError(null);

        const response = await githubApi.disconnect(projectId);
        setDisconnecting(false);

        if (!response.ok) {
            setError(response.error || t("workspace.github.disconnectFailed"));
            return;
        }
        toast.success(t("workspace.github.repositoryDisconnected"));
        setCreatedRepository(null);
        setRepositories(null);
        await loadStatus();
    }

    const selectedRepositoryEntry = repositories?.find(
        entry => String(entry.id) === selectedRepository,
    );
    const selectedBranchName = selectedBranch.trim();
    const branchReady =
        !!selectedRepositoryEntry &&
        !branchLoading &&
        !branchError &&
        (repositoryEmpty
            ? isSafeBranchName(selectedBranchName)
            : !!branches?.some(branch => branch.name === selectedBranchName));

    const newRepositoryNameTrimmed = newRepositoryName.trim();
    const newRepositoryNameValid = isSafeRepoName(newRepositoryNameTrimmed);
    const newRepositoryNameInvalid = newRepositoryName.length > 0 && !newRepositoryNameValid;

    return (
        <>
            <Modal
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title={t("workspace.github.title")}
                description={t("workspace.github.description")}
                headerAside={
                    connection ? (
                        <StatusPill tone={connection.firstPushPending ? "warning" : "success"} dot>
                            {connection.firstPushPending
                                ? t("workspace.github.statusAwaitingFirstPush")
                                : t("workspace.github.statusConnected")}
                        </StatusPill>
                    ) : undefined
                }
            >
                <div className="space-y-4">
                    {loading && !status ? (
                        <div className="grid place-items-center py-8">
                            <LoaderIcon className="text-muted-foreground size-5 animate-spin" aria-hidden />
                        </div>
                    ) : null}

                    {error ? (
                        <div className="space-y-1.5">
                            <p className="text-destructive flex items-start gap-1.5 text-xs">
                                <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
                                {error}
                            </p>
                            {installationUrl ? (
                                <div className="flex flex-wrap items-center gap-3">
                                    <a
                                        href={installationUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2"
                                    >
                                        {t("workspace.github.reviewInstallation")}
                                        <ExternalLinkIcon className="size-3" aria-hidden />
                                    </a>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => void handleAuthorize()}
                                        disabled={authorizing}
                                    >
                                        {authorizing ? (
                                            <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                                        ) : null}
                                        {t("workspace.github.reconnectAccount")}
                                    </Button>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {!loading && !accountConnected ? (
                        /* ── Authorize the account ─────────────────────────── */
                        <div className="space-y-3">
                            <p className="text-muted-foreground text-xs">
                                {t("workspace.github.connectAccountHint")}
                            </p>
                            <Button size="sm" onClick={() => void handleAuthorize()} disabled={authorizing}>
                                {authorizing ? (
                                    <LoaderIcon className="size-4 animate-spin" aria-hidden />
                                ) : (
                                    <GithubIcon className="size-4" aria-hidden />
                                )}
                                {t("workspace.github.connectAccount")}
                            </Button>
                        </div>
                    ) : null}

                    {!loading && accountConnected && !connection ? (
                        /* ── Create a repository, or connect an existing one ─ */
                        <div className="space-y-3">
                            <p className="text-muted-foreground text-xs">
                                {t("workspace.github.accountConnected", { login: status?.login ?? "" })}
                            </p>

                            <div
                                role="radiogroup"
                                aria-label={t("workspace.github.setupMode")}
                                className="bg-[var(--clay-sunken)] grid grid-cols-2 gap-1 rounded-lg p-1"
                            >
                                <Button
                                    type="button"
                                    role="radio"
                                    aria-checked={mode === "create"}
                                    variant={mode === "create" ? "secondary" : "ghost"}
                                    size="sm"
                                    className="justify-center"
                                    disabled={creating || connecting}
                                    onClick={() => {
                                        setMode("create");
                                        setError(null);
                                    }}
                                >
                                    <PlusIcon className="size-4" aria-hidden />
                                    {t("workspace.github.modeCreate")}
                                </Button>
                                <Button
                                    type="button"
                                    role="radio"
                                    aria-checked={mode === "connect"}
                                    variant={mode === "connect" ? "secondary" : "ghost"}
                                    size="sm"
                                    className="justify-center"
                                    disabled={creating || connecting}
                                    onClick={() => {
                                        setMode("connect");
                                        setError(null);
                                    }}
                                >
                                    <GithubIcon className="size-4" aria-hidden />
                                    {t("workspace.github.modeConnect")}
                                </Button>
                            </div>

                            {mode === "create" ? (
                                /* ── Create a new, empty repository ─────────── */
                                <form className="space-y-3" onSubmit={handleCreateRepository}>
                                    <p className="text-muted-foreground text-xs">
                                        {t("workspace.github.createRepositoryHint")}
                                    </p>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="github-new-repository-name" className="text-xs">
                                            {t("workspace.github.repositoryName")}
                                        </Label>
                                        <Input
                                            id="github-new-repository-name"
                                            value={newRepositoryName}
                                            onChange={event => {
                                                setNewRepositoryName(event.target.value);
                                                setError(null);
                                            }}
                                            placeholder={t("workspace.github.repositoryNamePlaceholder")}
                                            maxLength={100}
                                            autoComplete="off"
                                            spellCheck={false}
                                            className="h-8 text-sm"
                                            aria-invalid={newRepositoryNameInvalid || undefined}
                                            aria-describedby="github-new-repository-name-help"
                                        />
                                        <p
                                            id="github-new-repository-name-help"
                                            className={
                                                newRepositoryNameInvalid
                                                    ? "text-destructive text-xs"
                                                    : "text-muted-foreground text-xs"
                                            }
                                        >
                                            {newRepositoryNameInvalid
                                                ? t("workspace.github.repositoryNameInvalid")
                                                : t("workspace.github.repositoryNameHint")}
                                        </p>
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="github-new-repository-visibility" className="text-xs">
                                            {t("workspace.github.visibility")}
                                        </Label>
                                        <Select
                                            value={newRepositoryVisibility}
                                            onValueChange={value =>
                                                setNewRepositoryVisibility(value === "private" ? "private" : "public")
                                            }
                                        >
                                            <SelectTrigger id="github-new-repository-visibility" size="sm">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="public">
                                                    {t("workspace.github.visibilityPublic")}
                                                </SelectItem>
                                                <SelectItem value="private">
                                                    {t("workspace.github.visibilityPrivate")}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-muted-foreground text-xs">
                                            {newRepositoryVisibility === "private"
                                                ? t("workspace.github.visibilityPrivateHint")
                                                : t("workspace.github.visibilityPublicHint")}
                                        </p>
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="github-new-repository-description" className="text-xs">
                                            {t("workspace.github.repositoryDescription")}
                                        </Label>
                                        <Textarea
                                            id="github-new-repository-description"
                                            value={newRepositoryDescription}
                                            onChange={event => setNewRepositoryDescription(event.target.value)}
                                            placeholder={t("workspace.github.repositoryDescriptionPlaceholder")}
                                            maxLength={350}
                                            rows={2}
                                            className="min-h-16 text-sm"
                                        />
                                    </div>

                                    <Button
                                        type="submit"
                                        size="sm"
                                        disabled={!newRepositoryNameValid || creating}
                                    >
                                        {creating ? (
                                            <LoaderIcon className="size-4 animate-spin" aria-hidden />
                                        ) : (
                                            <PlusIcon className="size-4" aria-hidden />
                                        )}
                                        {creating
                                            ? t("workspace.github.creatingRepository")
                                            : t("workspace.github.createAndConnect")}
                                    </Button>
                                </form>
                            ) : (
                                /* ── Connect an existing repository ─────────── */
                                <div className="space-y-3">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="github-repository" className="text-xs">
                                            {t("workspace.github.repository")}
                                        </Label>
                                        {repositoryLoading || (repositories === null && !repositoryError) ? (
                                            <div className="border-[var(--clay-line)] text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
                                                <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                                                {t("workspace.github.loadingRepositories")}
                                            </div>
                                        ) : repositoryError ? (
                                            <div className="border-destructive/30 space-y-2 rounded-md border p-2.5">
                                                <p className="text-destructive flex items-start gap-1.5 text-xs">
                                                    <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
                                                    {repositoryError}
                                                </p>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        setRepositoryError(null);
                                                        setRepositoryReloadKey(key => key + 1);
                                                    }}
                                                >
                                                    {t("workspace.github.retry")}
                                                </Button>
                                            </div>
                                        ) : repositories && repositories.length === 0 ? (
                                            <div className="space-y-1.5">
                                                <p className="text-muted-foreground text-xs">
                                                    {repositorySelection === "selected"
                                                        ? t("workspace.github.noRepositoriesSelected")
                                                        : t("workspace.github.noRepositories")}
                                                </p>
                                                {repositorySelection === "selected" && installationUrl ? (
                                                    <a
                                                        href={installationUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2"
                                                    >
                                                        {t("workspace.github.reviewInstallation")}
                                                        <ExternalLinkIcon className="size-3" aria-hidden />
                                                    </a>
                                                ) : null}
                                            </div>
                                        ) : repositories ? (
                                            <Select
                                                value={selectedRepository}
                                                onValueChange={value => {
                                                    setSelectedRepository(value);
                                                    setError(null);
                                                }}
                                            >
                                                <SelectTrigger id="github-repository" size="sm">
                                                    <SelectValue placeholder={t("workspace.github.repositories")} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {repositories.map(repository => (
                                                        <SelectItem key={repository.id} value={String(repository.id)}>
                                                            {repository.fullName}
                                                            {repository.private ? " · private" : ""}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        ) : null}
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="github-branch" className="text-xs">
                                            {t("workspace.github.branch")}
                                        </Label>
                                        {!selectedRepository ? (
                                            <Select disabled value="">
                                                <SelectTrigger id="github-branch" size="sm">
                                                    <SelectValue placeholder={t("workspace.github.chooseRepositoryFirst")} />
                                                </SelectTrigger>
                                                <SelectContent />
                                            </Select>
                                        ) : branchLoading || (branches === null && !branchError) ? (
                                            <div className="border-[var(--clay-line)] text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
                                                <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                                                {t("workspace.github.loadingBranches")}
                                            </div>
                                        ) : branchError ? (
                                            <div className="border-destructive/30 space-y-2 rounded-md border p-2.5">
                                                <p className="text-destructive flex items-start gap-1.5 text-xs">
                                                    <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
                                                    {branchError}
                                                </p>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        setBranchError(null);
                                                        setBranchReloadKey(key => key + 1);
                                                    }}
                                                >
                                                    {t("workspace.github.retry")}
                                                </Button>
                                            </div>
                                        ) : repositoryEmpty ? (
                                            <>
                                                <Input
                                                    id="github-branch"
                                                    value={selectedBranch}
                                                    onChange={event => setSelectedBranch(event.target.value)}
                                                    placeholder="main"
                                                    maxLength={255}
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                    className="h-8 font-mono text-sm"
                                                />
                                                {selectedBranchName && !isSafeBranchName(selectedBranchName) ? (
                                                    <p className="text-destructive text-xs">
                                                        {t("workspace.github.branchInvalid")}
                                                    </p>
                                                ) : (
                                                    <p className="text-muted-foreground text-xs">
                                                        {t("workspace.github.emptyRepositoryHint", {
                                                            branch: selectedBranchName || "main",
                                                        })}
                                                    </p>
                                                )}
                                            </>
                                        ) : branches && branches.length > 0 ? (
                                            <>
                                                <Select value={selectedBranch} onValueChange={setSelectedBranch}>
                                                    <SelectTrigger id="github-branch" size="sm">
                                                        <SelectValue placeholder={t("workspace.github.branch")} />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {branches.map(branch => (
                                                            <SelectItem key={branch.name} value={branch.name}>
                                                                {branch.name}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                {selectedBranchName ? (
                                                    <p className="text-muted-foreground text-xs">
                                                        {t("workspace.github.branchHint", {
                                                            branch: selectedBranchName,
                                                        })}
                                                    </p>
                                                ) : null}
                                            </>
                                        ) : (
                                            <p className="text-muted-foreground text-xs">
                                                {t("workspace.github.noBranches")}
                                            </p>
                                        )}
                                    </div>

                                    <Button
                                        size="sm"
                                        onClick={() => void handleConnect()}
                                        disabled={!branchReady || connecting}
                                    >
                                        {connecting ? (
                                            <LoaderIcon className="size-4 animate-spin" aria-hidden />
                                        ) : (
                                            <CheckCircle2Icon className="size-4" aria-hidden />
                                        )}
                                        {repositoryEmpty
                                            ? t("workspace.github.connectEmptyRepository", {
                                                  branch: selectedBranchName || "main",
                                              })
                                            : t("workspace.github.connectRepository")}
                                    </Button>
                                </div>
                            )}
                        </div>
                    ) : null}

                    {!loading && connection ? (
                        /* ── Connected ─────────────────────────────────────── */
                        <div className="space-y-3">
                            <div className="border-[var(--clay-line)] bg-card rounded-lg border p-3 shadow-[var(--clay-elev-1)]">
                                <div className="flex flex-wrap items-center gap-2">
                                    <GithubIcon className="size-4 shrink-0" aria-hidden />
                                    <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
                                        {connection.repositoryFullName}
                                    </code>
                                    <Button variant="ghost" size="icon" className="size-7" asChild>
                                        <a
                                            href={`https://github.com/${connection.repositoryFullName}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            aria-label={t("common.openInNewTab")}
                                        >
                                            <GithubIcon className="size-3.5" aria-hidden />
                                        </a>
                                    </Button>
                                </div>
                                <p className="text-muted-foreground mt-1.5 font-mono text-xs">
                                    {connection.branch}
                                </p>
                                {connection.firstPushPending ? (
                                    <>
                                        {createdRepository === connection.repositoryFullName ? (
                                            <p className="text-muted-foreground mt-1.5 text-xs font-medium">
                                                {t("workspace.github.repositoryCreatedFirstPush", {
                                                    branch: connection.branch,
                                                })}
                                            </p>
                                        ) : null}
                                        <p className="text-muted-foreground mt-1.5 text-xs">
                                            {t("workspace.github.firstPushPending", {
                                                branch: connection.branch,
                                            })}
                                        </p>
                                    </>
                                ) : null}
                                {connection.lastPushedCommitSha ? (
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        {t("workspace.github.lastPush")}:{" "}
                                        <a
                                            href={`https://github.com/${connection.repositoryFullName}/commit/${connection.lastPushedCommitSha}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary inline-flex items-center gap-1 font-mono underline underline-offset-2"
                                        >
                                            {connection.lastPushedCommitSha.slice(0, 7)}
                                            <ExternalLinkIcon className="size-3" aria-hidden />
                                        </a>
                                    </p>
                                ) : null}
                                {connection.syncStatus === "conflict" ? (
                                    <p className="text-destructive mt-2 flex items-start gap-1.5 text-xs">
                                        <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
                                        {t("workspace.github.pushConflict")}
                                    </p>
                                ) : null}
                            </div>

                            <div className="flex flex-wrap gap-2">
                                <Button size="sm" onClick={() => void handlePush()} disabled={pushing}>
                                    {pushing ? (
                                        <LoaderIcon className="size-4 animate-spin" aria-hidden />
                                    ) : (
                                        <UploadIcon className="size-4" aria-hidden />
                                    )}
                                    {pushing
                                        ? t("workspace.github.pushing")
                                        : connection.firstPushPending
                                          ? t("workspace.github.pushAndCreateBranch", {
                                                branch: connection.branch,
                                            })
                                          : t("workspace.github.push")}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void handleImportPlan()}
                                    disabled={importing || connection.firstPushPending}
                                >
                                    {importing ? (
                                        <LoaderIcon className="size-4 animate-spin" aria-hidden />
                                    ) : (
                                        <DownloadIcon className="size-4" aria-hidden />
                                    )}
                                    {t("workspace.github.importFromGithub")}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive ml-auto"
                                    onClick={() => void handleDisconnect()}
                                    disabled={disconnecting}
                                >
                                    {t("workspace.github.disconnectRepository")}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void handleDisconnectAccount()}
                                    disabled={disconnecting}
                                >
                                    {t("workspace.github.disconnectAccount")}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </div>
            </Modal>

            {/* ── The import plan, before anything is replaced ───────────── */}
            <ConfirmDialog
                open={!!importPlan}
                onOpenChange={next => {
                    if (!next) setImportPlan(null);
                }}
                title={t("workspace.github.importFromGithub")}
                description={t("workspace.github.importPlan")}
                confirmLabel={t("workspace.github.importConfirm")}
                cancelLabel={t("workspace.restore.cancel")}
                onConfirm={handleImportConfirm}
            >
                {importPlan ? (
                    <div className="space-y-2 text-xs">
                        <ul className="text-muted-foreground space-y-0.5">
                            <li>{t("workspace.restore.changed", { count: importPlan.added.length + importPlan.modified.length + importPlan.removed.length })}</li>
                            <li>{"+ "}{importPlan.added.length}{" · "}{importPlan.modified.length}{" · "}{importPlan.removed.length}</li>
                        </ul>
                        {importPlan.modified.length > 0 ? (
                            <p className="text-muted-foreground max-h-32 overflow-auto font-mono">
                                {importPlan.modified.slice(0, 20).join("\n")}
                            </p>
                        ) : null}
                        {importPlan.excluded.length > 0 ? (
                            <div className="space-y-1">
                                <p className="text-muted-foreground">
                                    {t("workspace.github.excludedFiles", { count: importPlan.excluded.length })}
                                </p>
                                <ul className="text-muted-foreground max-h-24 overflow-auto font-mono">
                                    {importPlan.excluded.slice(0, 8).map((file) => (
                                        <li key={`${file.path}:${file.reason}`}>
                                            {file.path} — {file.reason}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </ConfirmDialog>

            {/* ── The branch moved: a separate, explicit confirmation ───── */}
            <ConfirmDialog
                open={conflictOpen}
                onOpenChange={setConflictOpen}
                tone="danger"
                title={t("workspace.github.pushConflictTitle")}
                description={t("workspace.github.pushConflict")}
                confirmLabel={t("workspace.github.push")}
                cancelLabel={t("workspace.restore.cancel")}
                onConfirm={() => handlePush(true)}
            />
        </>
    );
}
