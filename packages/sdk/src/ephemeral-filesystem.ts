import * as fs from "node:fs/promises";
import path from "node:path";
import type { SessionFsProvider, SessionFsFileInfo } from "@github/copilot-sdk";

/**
 * CLI 1.0.83's enableSessionStore disables indexing, not events.jsonl.
 * Route session state through the supported SessionFs provider: discard event
 * logs at write time, keep other runtime metadata only in helper memory.
 * Workspace tools still operate on local files. This is not an OS sandbox.
 */
export class EphemeralFilesystem implements SessionFsProvider {
    private readonly files = new Map<string, string>();
    private readonly directories = new Set<string>();
    constructor(private readonly stateRoot: string, private readonly workingDirectory: string) {
        this.directories.add(stateRoot);
    }
    private normalize(value: string): string { return path.resolve(this.workingDirectory, value); }
    private state(value: string): boolean { return value === this.stateRoot || value.startsWith(this.stateRoot + path.sep); }
    private log(value: string): boolean { return /(?:^|\/)events(?:\.[^/]*)?\.jsonl$/.test(value); }
    private missing(): Error { return Object.assign(new Error("Ephemeral file unavailable."), { code: "ENOENT" }); }
    private parents(value: string): void {
        for (let parent = path.dirname(value); this.state(parent); parent = path.dirname(parent)) {
            this.directories.add(parent);
            if (parent === this.stateRoot) break;
        }
    }
    async readFile(value: string): Promise<string> {
        const file = this.normalize(value);
        if (!this.state(file)) return fs.readFile(file, "utf8");
        if (!this.files.has(file)) throw this.missing();
        return this.files.get(file)!;
    }
    async writeFile(value: string, content: string, mode?: number): Promise<void> {
        const file = this.normalize(value);
        if (!this.state(file)) {
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await fs.writeFile(file, content, { mode: mode ?? 0o600 }); return;
        }
        this.parents(file);
        this.files.set(file, this.log(file) ? "" : content);
    }
    async appendFile(value: string, content: string, mode?: number): Promise<void> {
        const file = this.normalize(value);
        if (!this.state(file)) { await fs.appendFile(file, content, { mode: mode ?? 0o600 }); return; }
        await this.writeFile(file, this.log(file) ? "" : (this.files.get(file) ?? "") + content, mode);
    }
    async exists(value: string): Promise<boolean> {
        const file = this.normalize(value);
        if (this.state(file)) return this.files.has(file) || this.directories.has(file);
        try { await fs.stat(file); return true; } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }
    async stat(value: string): Promise<SessionFsFileInfo> {
        const file = this.normalize(value);
        if (!this.state(file)) {
            const stat = await fs.stat(file);
            return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size,
                mtime: stat.mtime.toISOString(), birthtime: stat.birthtime.toISOString() };
        }
        if (!await this.exists(file)) throw this.missing();
        return { isFile: this.files.has(file), isDirectory: this.directories.has(file),
            size: Buffer.byteLength(this.files.get(file) ?? ""), mtime: new Date(0).toISOString(), birthtime: new Date(0).toISOString() };
    }
    async mkdir(value: string, recursive: boolean, mode?: number): Promise<void> {
        const directory = this.normalize(value);
        if (!this.state(directory)) { await fs.mkdir(directory, { recursive, mode: mode ?? 0o700 }); return; }
        this.parents(directory); this.directories.add(directory);
    }
    async readdir(value: string): Promise<string[]> {
        const directory = this.normalize(value);
        if (!this.state(directory)) return fs.readdir(directory);
        if (!this.directories.has(directory)) throw this.missing();
        return [...new Set([...this.files.keys(), ...this.directories].filter(file => path.dirname(file) === directory && file !== directory).map(file => path.basename(file)))];
    }
    async readdirWithTypes(value: string): ReturnType<SessionFsProvider["readdirWithTypes"]> {
        return Promise.all((await this.readdir(value)).map(async name => ({
            name, type: (await this.stat(path.join(value, name))).isDirectory ? "directory" as const : "file" as const,
        })));
    }
    async rm(value: string, recursive: boolean, force: boolean): Promise<void> {
        const file = this.normalize(value);
        if (!this.state(file)) { await fs.rm(file, { recursive, force }); return; }
        if (!force && !await this.exists(file)) throw this.missing();
        for (const key of [...this.files.keys(), ...this.directories]) {
            if (key === file || (recursive && key.startsWith(file + path.sep))) {
                this.files.delete(key); this.directories.delete(key);
            }
        }
    }
    async rename(source: string, destination: string): Promise<void> {
        const src = this.normalize(source), dest = this.normalize(destination);
        if (!this.state(src) && !this.state(dest)) { await fs.rename(src, dest); return; }
        if (!this.state(src) || !this.state(dest)) throw new Error("Ephemeral state cannot leave memory.");
        if (!await this.exists(src)) throw this.missing();
        this.parents(dest);
        for (const [key, value] of [...this.files]) {
            if (key === src || key.startsWith(src + path.sep)) {
                this.files.delete(key); this.files.set(dest + key.slice(src.length), this.log(dest + key.slice(src.length)) ? "" : value);
            }
        }
        for (const key of [...this.directories]) {
            if (key === src || key.startsWith(src + path.sep)) {
                this.directories.delete(key); this.directories.add(dest + key.slice(src.length));
            }
        }
    }
}
