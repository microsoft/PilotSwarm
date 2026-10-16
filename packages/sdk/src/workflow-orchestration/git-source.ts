import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
    checkImportUrl,
    type ImportPolicy,
} from "../agent-package-import-policy.js";
import { assertHostResolvesPublicly } from "../agent-package-import-fetch.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

export interface WorkflowGitSource {
    kind: "git";
    repositoryUrl: string;
    gitRef: string;
    workflowPath: string;
}

export interface ResolvedWorkflowGitSource extends WorkflowGitSource {
    commitSha: string;
}

export interface ResolvedWorkflowGitPackage {
    checkoutRoot: string;
    packageRoot: string;
    workflowYaml: string;
    source: ResolvedWorkflowGitSource;
    cleanup(): Promise<void>;
}

export interface WorkflowPackageResolver {
    resolve(source: WorkflowGitSource): Promise<ResolvedWorkflowGitPackage>;
}

export function createWorkflowGitPackageResolver(
    policy: ImportPolicy,
    options: {
        runGit?: WorkflowGitRunner;
        resolveHost?: (hostname: string) => Promise<unknown>;
    } = {},
): WorkflowPackageResolver {
    return {
        resolve(source) {
            return resolveWorkflowGitPackage(source, policy, options);
        },
    };
}

function gitSourceError(message: string, code: string, cause?: unknown): Error {
    return Object.assign(new Error(message), {
        code,
        ...(cause === undefined ? {} : { cause }),
    });
}

function requireGitRef(value: unknown): string {
    if (
        typeof value !== "string"
        || value.trim().length === 0
        || value.length > 1024
        || value.trim().startsWith("-")
        || /[\s~^:?*[\]\\]/.test(value)
        || value.includes("@{")
    ) {
        throw gitSourceError(
            "gitRef must be a non-empty Git revision or reference without option or refspec syntax.",
            "WORKFLOW_GIT_REF_INVALID",
        );
    }
    return value.trim();
}

function requireWorkflowPath(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw gitSourceError(
            "workflowPath must be a package-relative YAML path.",
            "WORKFLOW_GIT_PATH_INVALID",
        );
    }
    const normalized = value.trim().replaceAll("\\", "/");
    if (
        normalized.startsWith("/")
        || /^[A-Za-z]:/.test(normalized)
        || normalized.split("/").some(segment => segment === "" || segment === "." || segment === "..")
        || !/\.ya?ml$/i.test(normalized)
    ) {
        throw gitSourceError(
            "workflowPath must be a package-relative .yaml or .yml path without traversal.",
            "WORKFLOW_GIT_PATH_INVALID",
        );
    }
    return normalized;
}

export type WorkflowGitRunner = (
    cwd: string,
    hooksDirectory: string,
    args: string[],
) => Promise<string>;

async function runGit(cwd: string, hooksDirectory: string, args: string[]): Promise<string> {
    try {
        const result = await execFileAsync(
            "git",
            [
                "-c", `core.hooksPath=${hooksDirectory}`,
                "-c", "http.followRedirects=false",
                ...args,
            ],
            {
                cwd,
                encoding: "utf8",
                maxBuffer: 8 * 1024 * 1024,
                timeout: GIT_TIMEOUT_MS,
                env: {
                    ...process.env,
                    GIT_LFS_SKIP_SMUDGE: "1",
                    GIT_TERMINAL_PROMPT: "0",
                },
                windowsHide: true,
            },
        );
        return result.stdout.trim();
    } catch (cause) {
        throw gitSourceError(
            `Git command '${args[0]}' failed while resolving the workflow package.`,
            "WORKFLOW_GIT_RESOLUTION_FAILED",
            cause,
        );
    }
}

export async function resolveWorkflowGitPackage(
    input: WorkflowGitSource,
    policy: ImportPolicy,
    options: {
        runGit?: WorkflowGitRunner;
        resolveHost?: (hostname: string) => Promise<unknown>;
    } = {},
): Promise<ResolvedWorkflowGitPackage> {
    if (!input || input.kind !== "git") {
        throw gitSourceError(
            "Workflow registration source must have kind 'git'.",
            "WORKFLOW_GIT_SOURCE_INVALID",
        );
    }
    const decision = checkImportUrl(input.repositoryUrl, policy);
    if (!decision.allowed || !decision.url) {
        throw gitSourceError(
            `Workflow Git repository is not allowed: ${decision.reason ?? "repository URL refused"}.`,
            "WORKFLOW_GIT_REPOSITORY_REFUSED",
        );
    }
    const repositoryUrl = decision.url;
    const repository = new URL(repositoryUrl);
    if (repository.search || repository.hash) {
        throw gitSourceError(
            "Workflow Git repository URLs must not contain query parameters or fragments.",
            "WORKFLOW_GIT_REPOSITORY_REFUSED",
        );
    }
    try {
        await (options.resolveHost ?? assertHostResolvesPublicly)(repository.hostname);
    } catch (cause) {
        throw gitSourceError(
            `Workflow Git repository host '${repository.hostname}' was refused by network policy.`,
            "WORKFLOW_GIT_REPOSITORY_REFUSED",
            cause,
        );
    }
    const gitRef = requireGitRef(input.gitRef);
    const workflowPath = requireWorkflowPath(input.workflowPath);

    const checkoutRoot = await mkdtemp(path.join(tmpdir(), "ps-workflow-git-"));
    const hooksDirectory = path.join(checkoutRoot, ".disabled-hooks");
    const repositoryRoot = path.join(checkoutRoot, "repository");
    await mkdir(hooksDirectory);
    await mkdir(repositoryRoot);
    const executeGit = options.runGit ?? runGit;

    try {
        await executeGit(repositoryRoot, hooksDirectory, ["init", "--quiet"]);
        await executeGit(repositoryRoot, hooksDirectory, ["remote", "add", "origin", repositoryUrl]);
        await executeGit(repositoryRoot, hooksDirectory, [
            "fetch",
            "--quiet",
            "--depth=1",
            "--no-tags",
            "origin",
            gitRef,
        ]);
        const commitSha = await executeGit(repositoryRoot, hooksDirectory, ["rev-parse", "FETCH_HEAD"]);
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commitSha)) {
            throw gitSourceError(
                "Resolved Git commit has an invalid object identity.",
                "WORKFLOW_GIT_COMMIT_INVALID",
            );
        }
        await executeGit(repositoryRoot, hooksDirectory, [
            "checkout",
            "--quiet",
            "--detach",
            "--force",
            commitSha,
        ]);

        const workflowFile = path.resolve(repositoryRoot, workflowPath);
        const workflowRealPath = await realpath(workflowFile).catch(() => null);
        const repositoryRealPath = await realpath(repositoryRoot);
        if (
            !workflowRealPath
            || (
                workflowRealPath !== repositoryRealPath
                && !workflowRealPath.startsWith(`${repositoryRealPath}${path.sep}`)
            )
        ) {
            throw gitSourceError(
                `Workflow file '${workflowPath}' does not exist inside the resolved repository.`,
                "WORKFLOW_GIT_WORKFLOW_NOT_FOUND",
            );
        }
        const packageRoot = path.dirname(workflowRealPath);
        const workflowYaml = await readFile(workflowRealPath, "utf8");
        return {
            checkoutRoot,
            packageRoot,
            workflowYaml,
            source: {
                kind: "git",
                repositoryUrl,
                gitRef,
                workflowPath,
                commitSha,
            },
            cleanup: () => rm(checkoutRoot, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(checkoutRoot, { recursive: true, force: true });
        throw error;
    }
}
