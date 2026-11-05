import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Windows archives round-trip with both native and Git Bash tar using native directory spellings",
    { skip: process.platform !== "win32", timeout: 30_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps native archive paths-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const gitRoot = path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "..", "..", "..");
    const variants = [
        { name: "native Windows", executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") },
        { name: "Git Bash", executable: path.join(gitRoot, "usr", "bin", "tar.exe") },
    ];
    const module = fileURLToPath(new URL("../../dist/session-store.js", import.meta.url));
    for (const [index, variant] of variants.entries()) await t.test(variant.name, async st => {
        await fs.access(variant.executable);
        const directory = path.join(root, String(index));
        await fs.mkdir(directory);
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            ["systemroot", "windir", "temp", "tmp", "comspec", "pathext"].includes(key.toLowerCase())));
        env.PATH = path.dirname(variant.executable);
        const script = `
            import fs from "node:fs/promises";
            import path from "node:path";
            import assert from "node:assert/strict";
            import { pathToFileURL } from "node:url";
            const { archiveSessionDir, extractSessionArchive } = await import(pathToFileURL(process.argv[1]));
            const source = path.join(process.cwd(), "source");
            const destination = path.join(process.cwd(), "restored");
            await fs.mkdir(path.join(source, "session", "files", "empty"), { recursive: true });
            const body = Buffer.from([0, 255, 13, 10]);
            await fs.writeFile(path.join(source, "session", "files", "value.bin"), body);
            const archive = path.join(process.cwd(), "state.tar.br");
            await archiveSessionDir(source, "session", archive, "brotli");
            await extractSessionArchive(destination, archive, "brotli");
            assert.deepEqual(await fs.readFile(path.join(destination, "session", "files", "value.bin")), body);
            assert.equal((await fs.stat(path.join(destination, "session", "files", "empty"))).isDirectory(), true);
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, module], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
        st.after(async () => {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = new Promise(resolve => child.once("exit", resolve));
                child.kill();
                await exited;
            }
        });
        let output = "";
        child.stdout.on("data", bytes => { output += bytes; });
        child.stderr.on("data", bytes => { output += bytes; });
        const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
        assert.equal(code, 0, output);
    });
});
