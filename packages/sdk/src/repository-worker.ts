import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
    checkoutDetached,
    makeRunGit,
    normalizeRef,
    resolveTargetRef,
    type RunGit,
} from "./repository-git.js";
import type {
    BeforeTurnHook,
} from "./turn-lifecycle-hooks.js";
import type { SerializableSessionConfig } from "./types.js";

interface RepositoryWorkspaceState {
    version: 1;
    repositoryFingerprint: string;
    targetRef: string | null;
    sessionId: string | null;
}

export interface StickyRepositoryWorkspaceOptions {
    repositoryUrl: string;
    directory: string;
    targetRef?: string | null;
    runGit?: RunGit;
    trace?: (message: string) => void;
}

export interface StickyRepositoryWorkspaceStatus {
    directory: string;
    headSha: string;
    sessionId: string | null;
    created: boolean;
}

const STATE_FILE = "pilotswarm-repository-worker.json";

function repositoryFingerprint(repositoryUrl: string): string {
    return createHash("sha256").update(repositoryUrl, "utf8").digest("hex");
}

function validateRepositoryUrl(repositoryUrl: string): void {
    if (
        !repositoryUrl
        || repositoryUrl.startsWith("-")
        || /[\u0000\r\n]/.test(repositoryUrl)
    ) {
        throw new Error(`Invalid repository URL or path: ${JSON.stringify(repositoryUrl)}`);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repositoryUrl)) {
        let parsed: URL;
        try {
            parsed = new URL(repositoryUrl);
        } catch (error) {
            throw new Error("Repository URL is invalid", { cause: error });
        }
        const allowsUsername = parsed.protocol === "ssh:";
        if (parsed.password || (parsed.username && !allowsUsername)) {
            throw new Error(
                "Repository URL must not contain credentials; use the Git credential environment",
            );
        }
        if (parsed.search || parsed.hash) {
            throw new Error(
                "Repository URL must not contain a query or fragment; use the Git credential environment",
            );
        }
    }
}

function validateSessionId(sessionId: string): void {
    if (!sessionId || /[\u0000-\u001f\u007f]/.test(sessionId)) {
        throw new Error(`Invalid repository-worker session id: ${JSON.stringify(sessionId)}`);
    }
}

/**
 * Owns one persistent repository checkout that is permanently claimed by the
 * first session routed to it. The checkout survives process restarts and keeps
 * that session's local commits and working-tree changes on local storage.
 *
 * This is intentionally a sticky, single-session execution mode. It does not
 * provide cross-worker failover or transactionally coordinate repository state
 * with PilotSwarm's durable session snapshot.
 */
export class StickyRepositoryWorkspace {
    readonly repositoryUrl: string;
    readonly directory: string;
    readonly targetRef: string | null;
    readonly beforeTurn: BeforeTurnHook<SerializableSessionConfig>;

    private readonly fingerprint: string;
    private readonly git: RunGit;
    private readonly trace: (message: string) => void;
    private initialized = false;
    private lockTail: Promise<void> = Promise.resolve();

    constructor(options: StickyRepositoryWorkspaceOptions) {
        const repositoryUrl = String(options.repositoryUrl ?? "").trim();
        validateRepositoryUrl(repositoryUrl);

        const requestedDirectory = path.resolve(options.directory);
        const parent = path.dirname(requestedDirectory);
        fs.mkdirSync(parent, { recursive: true });
        if (fs.lstatSync(parent).isSymbolicLink()) {
            throw new Error(`Repository workspace parent must not be a symbolic link: ${parent}`);
        }

        this.repositoryUrl = repositoryUrl;
        this.directory = path.join(fs.realpathSync.native(parent), path.basename(requestedDirectory));
        this.targetRef = String(options.targetRef ?? "").trim() || null;
        if (this.targetRef) {
            normalizeRef(this.targetRef);
        }
        this.fingerprint = repositoryFingerprint(repositoryUrl);
        this.git = options.runGit ?? makeRunGit();
        this.trace = options.trace ?? (() => {});
        this.beforeTurn = async (context) => {
            const configuredDirectory = context.config.workingDirectory;
            if (
                configuredDirectory
                && path.relative(this.directory, path.resolve(configuredDirectory)) !== ""
            ) {
                throw new Error(
                    `Session ${context.sessionId} requested working directory `
                    + `${configuredDirectory}; sticky repository workers require ${this.directory}`,
                );
            }
            const status = await this.acquire(context.sessionId);
            context.trace(
                `[repository-worker] workspace ready session=${context.sessionId} `
                + `head=${status.headSha.slice(0, 12)} created=${status.created}`,
            );
        };
    }

    async initialize(): Promise<StickyRepositoryWorkspaceStatus> {
        return this.withLock(() => this.initializeUnlocked());
    }

    async acquire(sessionId: string): Promise<StickyRepositoryWorkspaceStatus> {
        validateSessionId(sessionId);
        return this.withLock(async () => {
            const initialized = await this.initializeUnlocked();
            const state = this.readState();
            if (state.sessionId && state.sessionId !== sessionId) {
                throw new Error(
                    `Repository workspace is already claimed by session ${state.sessionId}; `
                    + `route session ${sessionId} to a different sticky worker`,
                );
            }
            if (!state.sessionId) {
                this.writeState({ ...state, sessionId });
                this.log(`[repository-worker] workspace claimed by session ${sessionId}`);
            }
            const headSha = this.git(this.directory, ["rev-parse", "HEAD"]);
            return {
                ...initialized,
                headSha,
                sessionId,
            };
        });
    }

    private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
        const previous = this.lockTail;
        let release!: () => void;
        this.lockTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private async initializeUnlocked(): Promise<StickyRepositoryWorkspaceStatus> {
        if (this.initialized) {
            const state = this.readState();
            return {
                directory: this.directory,
                headSha: this.git(this.directory, ["rev-parse", "HEAD"]),
                sessionId: state.sessionId,
                created: false,
            };
        }

        this.git(path.dirname(this.directory), ["--version"]);
        let created = false;
        if (!fs.existsSync(this.directory)) {
            this.cloneAtomically();
            created = true;
        } else {
            if (fs.lstatSync(this.directory).isSymbolicLink()) {
                throw new Error(
                    `Repository workspace must not be a symbolic link: ${this.directory}`,
                );
            }
            if (!fs.existsSync(path.join(this.directory, ".git"))) {
                throw new Error(
                    `Repository workspace exists but is not a managed Git checkout: ${this.directory}`,
                );
            }
            const gitDirectory = path.join(this.directory, ".git");
            const gitDirectoryStat = fs.lstatSync(gitDirectory);
            if (!gitDirectoryStat.isDirectory() || gitDirectoryStat.isSymbolicLink()) {
                throw new Error(
                    `Repository workspace must own its .git directory: ${this.directory}`,
                );
            }
            this.assertStateMatchesConfiguration(this.readState());
            this.git(this.directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
        }

        this.initialized = true;
        const state = this.readState();
        const headSha = this.git(this.directory, ["rev-parse", "HEAD"]);
        this.log(
            `[repository-worker] ${created ? "created" : "reused"} `
            + `repository=${this.fingerprint.slice(0, 12)} at ${this.directory} `
            + `head=${headSha.slice(0, 12)}`,
        );
        return {
            directory: this.directory,
            headSha,
            sessionId: state.sessionId,
            created,
        };
    }

    private cloneAtomically(): void {
        const parent = path.dirname(this.directory);
        const temporaryDirectory = `${this.directory}.clone-${process.pid}-${randomUUID()}`;
        try {
            this.git(parent, [
                "clone",
                "--no-hardlinks",
                "--no-checkout",
                this.repositoryUrl,
                temporaryDirectory,
            ]);
            const sha = this.resolveCloneTarget(temporaryDirectory);
            checkoutDetached({
                dir: temporaryDirectory,
                sha,
                runGit: this.git,
                trace: this.trace,
            });
            this.writeState({
                version: 1,
                repositoryFingerprint: this.fingerprint,
                targetRef: this.targetRef,
                sessionId: null,
            }, temporaryDirectory);
            fs.renameSync(temporaryDirectory, this.directory);
        } catch (error) {
            try {
                fs.rmSync(temporaryDirectory, { recursive: true, force: true });
            } catch {
                // Preserve the clone or checkout failure that made startup unsafe.
            }
            throw error;
        }
    }

    private resolveCloneTarget(directory: string): string {
        const ref = resolveTargetRef(undefined, {
            dir: directory,
            runGit: this.git,
            envRef: this.targetRef,
        });
        try {
            return this.git(directory, [
                "rev-parse",
                "--verify",
                `${ref}^{commit}`,
            ]);
        } catch (error) {
            if (!this.targetRef) throw error;
        }

        const fetchRef = this.targetRef.startsWith("origin/")
            ? this.targetRef.slice("origin/".length)
            : this.targetRef;
        this.git(directory, ["fetch", "--no-tags", "origin", fetchRef]);
        return this.git(directory, [
            "rev-parse",
            "--verify",
            "FETCH_HEAD^{commit}",
        ]);
    }

    private statePath(directory = this.directory): string {
        return path.join(directory, ".git", STATE_FILE);
    }

    private readState(): RepositoryWorkspaceState {
        const statePath = this.statePath();
        if (!fs.existsSync(statePath)) {
            throw new Error(
                `Repository workspace is missing its ownership state: ${statePath}`,
            );
        }
        const stateStat = fs.lstatSync(statePath);
        if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
            throw new Error(`Repository workspace state must be a regular file: ${statePath}`);
        }
        let value: unknown;
        try {
            value = JSON.parse(fs.readFileSync(statePath, "utf8"));
        } catch (error) {
            throw new Error(`Repository workspace state is unreadable: ${statePath}`, {
                cause: error,
            });
        }
        if (!value || typeof value !== "object") {
            throw new Error(`Repository workspace state is invalid: ${statePath}`);
        }
        const state = value as Partial<RepositoryWorkspaceState>;
        if (
            state.version !== 1
            || typeof state.repositoryFingerprint !== "string"
            || !/^[0-9a-f]{64}$/i.test(state.repositoryFingerprint)
            || !(state.targetRef === null || typeof state.targetRef === "string")
            || !(state.sessionId === null || typeof state.sessionId === "string")
        ) {
            throw new Error(`Repository workspace state is invalid: ${statePath}`);
        }
        if (state.sessionId !== null) {
            validateSessionId(state.sessionId);
        }
        this.assertStateMatchesConfiguration(state as RepositoryWorkspaceState);
        return state as RepositoryWorkspaceState;
    }

    private assertStateMatchesConfiguration(state: RepositoryWorkspaceState): void {
        if (
            state.repositoryFingerprint !== this.fingerprint
            || state.targetRef !== this.targetRef
        ) {
            throw new Error(
                "Repository workspace configuration does not match its persisted ownership state",
            );
        }
    }

    private writeState(
        state: RepositoryWorkspaceState,
        directory = this.directory,
    ): void {
        const statePath = this.statePath(directory);
        const temporaryPath = `${statePath}.tmp-${randomUUID()}`;
        fs.writeFileSync(temporaryPath, JSON.stringify(state), {
            encoding: "utf8",
            flag: "wx",
        });
        fs.renameSync(temporaryPath, statePath);
    }

    private log(message: string): void {
        this.trace(message);
    }
}
