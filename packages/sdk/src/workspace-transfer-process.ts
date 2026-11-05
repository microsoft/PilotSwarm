import { spawn } from "node:child_process";
import { workspaceFileError, WORKSPACE_FILE_ERROR_CODES } from "./workspace-files.js";

/** A resource promise: a timeout requests termination, but settles only after observed child exit. */
export function runWorkspaceTransferProcess<T>(
    script: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { PATH: process.env.PATH ?? "" },
        });
        const chunks: Buffer[] = [];
        let length = 0;
        let failure: Error | undefined;
        const terminate = (error: Error) => {
            failure ??= error;
            child.kill("SIGKILL");
        };
        const onAbort = () => terminate(workspaceFileError(WORKSPACE_FILE_ERROR_CODES.TIMEOUT, "Workspace transfer cancelled."));
        const timer = setTimeout(() => terminate(workspaceFileError(WORKSPACE_FILE_ERROR_CODES.TIMEOUT, "Workspace transfer helper timed out; its resources remain reserved until it exits.")), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.on("error", (error) => { failure ??= error; });
        child.stdout.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 32 * 1024) terminate(workspaceFileError(WORKSPACE_FILE_ERROR_CODES.IO, "Workspace transfer helper returned too much metadata."));
            else chunks.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on("error", () => { /* An early child exit is reported by close. */ });
        child.on("close", () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (failure) { reject(failure); return; }
            try {
                const answer = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!answer.ok) {
                    reject(Object.assign(new Error(answer.message || "Workspace transfer failed."), {
                        code: answer.code || WORKSPACE_FILE_ERROR_CODES.IO,
                        status: answer.status || 500,
                        ...(Object.hasOwn(answer, "etag") ? { etag: answer.etag } : {}),
                        expose: true,
                        preparationSafe: answer.preparationSafe === true,
                    }));
                } else resolve(answer.result);
            } catch {
                reject(workspaceFileError(WORKSPACE_FILE_ERROR_CODES.IO, "Workspace transfer helper exited without a receipt; publication may be uncertain."));
            }
        });
        child.stdin.end(JSON.stringify(request));
    });
}
