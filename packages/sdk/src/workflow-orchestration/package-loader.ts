import { createHash, randomUUID } from "node:crypto";
import {
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
    WorkflowTransitionRegistry,
    compileAndRegisterWorkflowYaml,
    compileWorkflowYaml,
    type CompiledWorkflowYaml,
    type WorkflowTransitionReference,
    type WorkflowTransitionRegistration,
} from "./compiler.js";
import type { WorkflowDefinitionSource } from "../types.js";

function packageError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTransitionRegistration(
    value: unknown,
): value is Pick<WorkflowTransitionRegistration, "allowedTargets" | "handler"> {
    return (
        isObject(value)
        && Array.isArray(value.allowedTargets)
        && typeof value.handler === "function"
    );
}

function requireString(value: unknown, pathLabel: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw packageError(
            `${pathLabel} must be a non-empty string.`,
            "WORKFLOW_TRANSITION_REFERENCE_INVALID",
        );
    }
    return value.trim();
}

interface WorkflowPackageFile {
    relativePath: string;
    bytes: Buffer;
}

interface WorkflowPackageSnapshot {
    root: string;
    packageSha256: string;
}

async function readWorkflowPackageFiles(
    packageRoot: string,
    currentDirectory = packageRoot,
): Promise<WorkflowPackageFile[]> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    const files: WorkflowPackageFile[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const entryPath = path.join(currentDirectory, entry.name);
        if (entry.isSymbolicLink()) {
            throw packageError(
                `Workflow package entry '${path.relative(packageRoot, entryPath)}' must not be a symbolic link.`,
                "WORKFLOW_PACKAGE_SYMLINK_UNSUPPORTED",
            );
        }
        if (entry.isDirectory()) {
            files.push(...await readWorkflowPackageFiles(packageRoot, entryPath));
            continue;
        }
        if (!entry.isFile()) {
            throw packageError(
                `Workflow package entry '${path.relative(packageRoot, entryPath)}' must be a regular file.`,
                "WORKFLOW_PACKAGE_ENTRY_INVALID",
            );
        }
        files.push({
            relativePath: path.relative(packageRoot, entryPath),
            bytes: await readFile(entryPath),
        });
    }
    return files;
}

function hashWorkflowPackage(files: readonly WorkflowPackageFile[]): string {
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(file.relativePath.replaceAll(path.sep, "/"));
        hash.update("\0");
        hash.update(String(file.bytes.byteLength));
        hash.update("\0");
        hash.update(file.bytes);
    }
    return hash.digest("hex");
}

async function materializeWorkflowPackageSnapshot(
    packageRoot: string,
): Promise<WorkflowPackageSnapshot> {
    const sourceRoot = await realpath(path.resolve(packageRoot)).catch(() => null);
    if (!sourceRoot) {
        throw packageError(
            `Workflow package root '${packageRoot}' does not exist.`,
            "WORKFLOW_PACKAGE_ROOT_NOT_FOUND",
        );
    }
    const files = await readWorkflowPackageFiles(sourceRoot);
    const packageSha256 = hashWorkflowPackage(files);
    const snapshotsRoot = path.join(tmpdir(), "pilotswarm-workflow-packages");
    const snapshotRoot = path.join(snapshotsRoot, packageSha256);
    const existingSnapshot = await stat(snapshotRoot).catch(() => null);
    if (!existingSnapshot) {
        await mkdir(snapshotsRoot, { recursive: true });
        const candidateRoot = path.join(
            snapshotsRoot,
            `${packageSha256}-${randomUUID()}`,
        );
        try {
            for (const file of files) {
                const destination = path.join(candidateRoot, file.relativePath);
                await mkdir(path.dirname(destination), { recursive: true });
                await writeFile(destination, file.bytes, { flag: "wx" });
            }
            await rename(candidateRoot, snapshotRoot).catch(async error => {
                if (!await stat(snapshotRoot).catch(() => null)) throw error;
            });
        } finally {
            await rm(candidateRoot, { recursive: true, force: true });
        }
    } else if (!existingSnapshot.isDirectory()) {
        throw packageError(
            `Workflow package snapshot '${packageSha256}' is not a directory.`,
            "WORKFLOW_PACKAGE_SNAPSHOT_INVALID",
        );
    }
    const snapshotFiles = await readWorkflowPackageFiles(snapshotRoot);
    if (hashWorkflowPackage(snapshotFiles) !== packageSha256) {
        throw packageError(
            `Workflow package snapshot '${packageSha256}' failed content verification.`,
            "WORKFLOW_PACKAGE_SNAPSHOT_INVALID",
        );
    }
    return { root: snapshotRoot, packageSha256 };
}

function transitionReferences(yaml: string): WorkflowTransitionReference[] {
    const document = parseDocument(yaml, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });
    if (document.errors.length > 0) {
        throw packageError(
            `Workflow YAML could not be parsed: ${document.errors.map(error => error.message).join("; ")}`,
            "WORKFLOW_YAML_INVALID",
        );
    }
    const root = document.toJS({ maxAliasCount: 50 });
    if (!isObject(root) || !isObject(root.states)) {
        return [];
    }

    const references = new Map<string, WorkflowTransitionReference>();
    for (const [stateId, stateValue] of Object.entries(root.states)) {
        if (!isObject(stateValue) || stateValue.type === "terminal") continue;
        if (!isObject(stateValue.transition) || !isObject(stateValue.transition.handler)) {
            throw packageError(
                `states.${stateId}.transition.handler must declare module and export.`,
                "WORKFLOW_TRANSITION_REFERENCE_INVALID",
            );
        }
        const reference = {
            module: requireString(
                stateValue.transition.handler.module,
                `states.${stateId}.transition.handler.module`,
            ),
            export: requireString(
                stateValue.transition.handler.export,
                `states.${stateId}.transition.handler.export`,
            ),
        };
        references.set(`${reference.module}#${reference.export}`, reference);
    }
    return [...references.values()];
}

async function resolvePackageModule(packageRoot: string, modulePath: string): Promise<string> {
    if (path.isAbsolute(modulePath) || !modulePath.startsWith("./")) {
        throw packageError(
            `Transition module '${modulePath}' must be a package-relative path beginning with './'.`,
            "WORKFLOW_TRANSITION_MODULE_PATH_INVALID",
        );
    }
    if (![".js", ".mjs"].includes(path.extname(modulePath).toLowerCase())) {
        throw packageError(
            `Transition module '${modulePath}' must be a .js or .mjs file.`,
            "WORKFLOW_TRANSITION_MODULE_PATH_INVALID",
        );
    }

    const root = await realpath(path.resolve(packageRoot)).catch(() => null);
    if (!root) {
        throw packageError(
            `Workflow package root '${packageRoot}' does not exist.`,
            "WORKFLOW_PACKAGE_ROOT_NOT_FOUND",
        );
    }
    const resolved = path.resolve(root, modulePath);
    const resolvedRealPath = await realpath(resolved).catch(() => null);
    if (!resolvedRealPath) {
        throw packageError(
            `Transition module '${modulePath}' does not exist in the workflow package.`,
            "WORKFLOW_TRANSITION_MODULE_NOT_FOUND",
        );
    }
    const relative = path.relative(root, resolvedRealPath);
    if (
        relative.length === 0
        || relative.startsWith(`..${path.sep}`)
        || relative === ".."
        || path.isAbsolute(relative)
    ) {
        throw packageError(
            `Transition module '${modulePath}' resolves outside the workflow package.`,
            "WORKFLOW_TRANSITION_MODULE_PATH_INVALID",
        );
    }
    return resolvedRealPath;
}

async function loadRegistration(
    snapshot: WorkflowPackageSnapshot,
    reference: WorkflowTransitionReference,
): Promise<WorkflowTransitionRegistration> {
    const resolvedModule = await resolvePackageModule(snapshot.root, reference.module);
    const fileStat = await stat(resolvedModule).catch(() => null);
    if (!fileStat?.isFile()) {
        throw packageError(
            `Transition module '${reference.module}' does not exist in the workflow package.`,
            "WORKFLOW_TRANSITION_MODULE_NOT_FOUND",
        );
    }
    const bytes = await readFile(resolvedModule);
    const moduleSha256 = createHash("sha256").update(bytes).digest("hex");
    const moduleUrl = pathToFileURL(resolvedModule);
    moduleUrl.searchParams.set("sha256", moduleSha256);
    const loaded = await import(moduleUrl.href).catch((cause: unknown) => {
        throw Object.assign(
            packageError(
                `Transition module '${reference.module}' could not be loaded.`,
                "WORKFLOW_TRANSITION_MODULE_LOAD_FAILED",
            ),
            { cause },
        );
    });
    const registration = loaded[reference.export];
    if (!isTransitionRegistration(registration)) {
        throw packageError(
            `Transition module '${reference.module}' export '${reference.export}' must provide allowedTargets and handler(context).`,
            "WORKFLOW_TRANSITION_EXPORT_INVALID",
        );
    }
    return {
        allowedTargets: registration.allowedTargets,
        handler: registration.handler,
        moduleIdentity: {
            ...reference,
            moduleSha256,
            packageSha256: snapshot.packageSha256,
        },
    };
}

export async function loadWorkflowTransitionRegistry(
    yaml: string,
    packageRoot: string,
): Promise<WorkflowTransitionRegistry> {
    const snapshot = await materializeWorkflowPackageSnapshot(packageRoot);
    const registry = new WorkflowTransitionRegistry();
    for (const reference of transitionReferences(yaml)) {
        registry.register(reference, await loadRegistration(snapshot, reference));
    }
    return registry;
}

export async function compileWorkflowPackageYaml(
    yaml: string,
    options: { packageRoot: string },
): Promise<CompiledWorkflowYaml> {
    const transitions = await loadWorkflowTransitionRegistry(yaml, options.packageRoot);
    return compileWorkflowYaml(yaml, { transitions });
}

export async function compileAndRegisterWorkflowPackageYaml(
    yaml: string,
    options: { packageRoot: string },
): Promise<{
    compiled: CompiledWorkflowYaml;
    definition: Extract<WorkflowDefinitionSource, { kind: "in-memory" }>;
}> {
    const transitions = await loadWorkflowTransitionRegistry(yaml, options.packageRoot);
    return compileAndRegisterWorkflowYaml(yaml, { transitions });
}
