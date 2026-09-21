import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SessionWorkspace {
    path: string;
    ownership: "platform" | "caller";
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_WORKSPACE_ID_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/;
const WORKSPACE_MARKER = ".pilotswarm-workspace.json";

function assertSessionWorkspaceId(sessionId: string): void {
    if (
        !sessionId
        || sessionId === "."
        || sessionId === ".."
        || INVALID_WORKSPACE_ID_CHARACTER.test(sessionId)
        || WINDOWS_RESERVED_NAME.test(sessionId)
        || sessionId.endsWith(".")
        || sessionId.endsWith(" ")
    ) {
        throw new Error(`Invalid session workspace id: ${JSON.stringify(sessionId)}`);
    }
}

function workspaceToken(sessionId: string): string {
    return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32);
}

function assertConfinedPath(rootDir: string, candidate: string): void {
    const relative = path.relative(rootDir, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Session workspace escaped managed root: ${candidate}`);
    }
}

function assertNoLinks(rootDir: string, candidate: string): void {
    let current = candidate;
    while (true) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`Symbolic links are not allowed in managed workspace paths: ${current}`);
        }
        if (current === rootDir) return;
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Managed workspace path is not rooted under ${rootDir}: ${candidate}`);
        }
        current = parent;
    }
}

function isInside(rootDir: string, candidate: string): boolean {
    const relative = path.relative(rootDir, candidate);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class SessionWorkspaceManager {
    readonly rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = path.resolve(rootDir);
        fs.mkdirSync(this.rootDir, { recursive: true });
        assertNoLinks(this.rootDir, this.rootDir);
    }

    resolve(sessionId: string, callerPath?: string): SessionWorkspace {
        assertSessionWorkspaceId(sessionId);
        if (callerPath) {
            const resolved = path.resolve(callerPath);
            if (isInside(this.rootDir, resolved)) {
                throw new Error(
                    `Caller-provided workspace must be outside the managed root: ${resolved}`,
                );
            }
            return { path: resolved, ownership: "caller" };
        }

        const workspacePath = path.join(this.rootDir, `session-${workspaceToken(sessionId)}`);
        assertConfinedPath(this.rootDir, workspacePath);
        assertNoLinks(this.rootDir, workspacePath);
        fs.mkdirSync(workspacePath, { recursive: true });
        assertNoLinks(this.rootDir, workspacePath);

        const markerPath = path.join(workspacePath, WORKSPACE_MARKER);
        const expected = JSON.stringify({ version: 1, sessionId });
        if (fs.existsSync(markerPath)) {
            if (fs.lstatSync(markerPath).isSymbolicLink()) {
                throw new Error(`Symbolic workspace ownership marker is not allowed: ${markerPath}`);
            }
            const actual = fs.readFileSync(markerPath, "utf8");
            if (actual !== expected) {
                throw new Error(`Workspace ownership marker mismatch: ${markerPath}`);
            }
        } else {
            fs.writeFileSync(markerPath, expected, { encoding: "utf8", flag: "wx" });
        }
        return { path: workspacePath, ownership: "platform" };
    }

    remove(sessionId: string): boolean {
        assertSessionWorkspaceId(sessionId);
        const workspacePath = path.join(this.rootDir, `session-${workspaceToken(sessionId)}`);
        assertConfinedPath(this.rootDir, workspacePath);
        if (!fs.existsSync(workspacePath)) return false;
        assertNoLinks(this.rootDir, workspacePath);

        const markerPath = path.join(workspacePath, WORKSPACE_MARKER);
        if (!fs.existsSync(markerPath) || fs.lstatSync(markerPath).isSymbolicLink()) return false;
        try {
            const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
                version?: number;
                sessionId?: string;
            };
            if (marker.version !== 1 || marker.sessionId !== sessionId) return false;
        } catch {
            return false;
        }

        fs.rmSync(workspacePath, { recursive: true, force: true });
        return true;
    }
}
