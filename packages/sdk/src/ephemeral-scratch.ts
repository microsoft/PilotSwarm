import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { EphemeralSessionError } from "./ephemeral-errors.js";

const PREFIX = "invocation-";
const MARKER = ".ephemeral-owner.json";

export interface EphemeralScratch {
    directory: string;
    home: string;
    cwd: string;
    copilotHome: string;
    token: string;
}

async function privateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
        throw new EphemeralSessionError("EPHEMERAL_ISOLATION_FAILED");
    }
}

async function owner(directory: string): Promise<{ token: string; pid: number; host: string } | null> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const markerPath = path.join(directory, MARKER);
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024
        || (typeof process.getuid === "function" && markerStat.uid !== process.getuid())) return null;
    let data;
    try { data = JSON.parse(await readFile(markerPath, "utf8")); } catch { return null; }
    return data?.version === 1 && data?.token === path.basename(directory)
        && Number.isSafeInteger(data.pid) && data.pid > 0 && typeof data.host === "string" ? data : null;
}

export async function createEphemeralScratch(root: string): Promise<EphemeralScratch> {
    root = path.resolve(root);
    // Allocate fresh state only; prior invocations remain operator-owned remnants.
    await privateDirectory(root);
    const token = `${PREFIX}${randomUUID()}`;
    const directory = path.join(root, token);
    await mkdir(directory, { mode: 0o700 });
    try {
        await writeFile(path.join(directory, MARKER),
            JSON.stringify({ version: 1, token, pid: process.pid, host: hostname() }),
            { mode: 0o600, flag: "wx" });
        const scratch = {
            directory, token, home: path.join(directory, "home"),
            cwd: path.join(directory, "work"), copilotHome: path.join(directory, "copilot"),
        };
        for (const child of [scratch.home, scratch.cwd, scratch.copilotHome, path.join(directory, "process-files")]) {
            await privateDirectory(child);
        }
        return scratch;
    } catch (error) {
        // This mkdir succeeded exclusively in this call; it is our directory
        // even if writing its ownership marker failed.
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

export async function removeEphemeralScratch(scratch: EphemeralScratch): Promise<void> {
    const owned = await owner(scratch.directory);
    if (!owned || owned.token !== scratch.token || owned.pid !== process.pid || owned.host !== hostname()) {
        throw new EphemeralSessionError("EPHEMERAL_CLEANUP_FAILED");
    }
    await rm(scratch.directory, { recursive: true, force: false });
}

/** A replacement environment, NOT a copy of the host's environment. */
export function ephemeralEnvironment(scratch: EphemeralScratch): Record<string, string> {
    const processFiles = path.join(scratch.directory, "process-files");
    return {
        HOME: scratch.home, USERPROFILE: scratch.home,
        XDG_CONFIG_HOME: scratch.home, XDG_CACHE_HOME: scratch.home,
        XDG_DATA_HOME: scratch.home, XDG_STATE_HOME: scratch.home,
        TMPDIR: processFiles, TMP: processFiles, TEMP: processFiles,
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        LANG: "C.UTF-8", TZ: "UTC",
        COPILOT_OTEL_ENABLED: "false",
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    };
}
