import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Writes via a temp file and rename, so a crash never leaves half a file. */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode });
    renameSync(temp, file);
}
