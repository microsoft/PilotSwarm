/**
 * PilotSwarm's own files inside a session's state folder are not the
 * runtime's to touch (docs/proposals/compute-providers.md, "Session state
 * on the worker").
 *
 * Worker recovery trusts the snapshot marker, the turn sentinel and the
 * committed-turn result. A runtime that could read, rewrite, remove or
 * rename any of them — or remove or rename the folder holding them — could
 * make the worker replay a turn, trust a dead incarnation's files, or hand
 * back a result that was never computed.
 *
 * Run: npx vitest run test/local/compute-session-fs-reserved.test.js
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerDirectorySessionFs, REMOTE_SESSION_STATE_ROOT } from "../../src/compute-runtime.ts";
import { PS_MARKER_FILE, PS_SENTINEL_FILE, PS_TURN_COMMIT_FILE } from "../../src/snapshot-protocol.ts";

const RESERVED = [PS_MARKER_FILE, PS_SENTINEL_FILE, PS_TURN_COMMIT_FILE, ".ps-hydrate-abc", ".ps-whatever-is-added-next"];

let dir;
let sessionFs;

/** The runtime names files under the virtual root it is given. */
function at(...parts) {
    return [REMOTE_SESSION_STATE_ROOT, ...parts].join("/");
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-session-fs-"));
    fs.mkdirSync(path.join(dir, "session-id"), { recursive: true });
    dir = path.join(dir, "session-id");
    for (const name of RESERVED) fs.writeFileSync(path.join(dir, name), `worker wrote ${name}`);
    fs.writeFileSync(path.join(dir, "workspace.yaml"), "session: yes\n");
    sessionFs = new WorkerDirectorySessionFs(dir);
});

afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe("a remote runtime and the worker's own files", () => {
    it.each(RESERVED)("refuses every operation on %s", async (name) => {
        await expect(sessionFs.readFile(at(name))).rejects.toThrow(/reserved/);
        await expect(sessionFs.writeFile(at(name), "mine")).rejects.toThrow(/reserved/);
        await expect(sessionFs.appendFile(at(name), "mine")).rejects.toThrow(/reserved/);
        await expect(sessionFs.stat(at(name))).rejects.toThrow(/reserved/);
        await expect(sessionFs.rm(at(name), false, true)).rejects.toThrow(/reserved/);
        await expect(sessionFs.rename(at(name), at("stolen.txt"))).rejects.toThrow(/reserved/);
        await expect(sessionFs.rename(at("workspace.yaml"), at(name))).rejects.toThrow(/reserved/);
        await expect(sessionFs.mkdir(at(name, "below"), true)).rejects.toThrow(/reserved/);
        // `exists` answers as it would for a file that is not there, so the
        // runtime does not even learn which control files the worker keeps.
        expect(await sessionFs.exists(at(name))).toBe(false);
        // Nothing of the file changed.
        expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(`worker wrote ${name}`);
    });

    it("refuses a file under a reserved directory", async () => {
        await expect(sessionFs.writeFile(at(".ps-hydrate-abc", "inside.txt"), "mine")).rejects.toThrow(/reserved/);
        await expect(sessionFs.rm(at(".ps-hydrate-abc", "inside.txt"), false, true)).rejects.toThrow(/reserved/);
    });

    it("never lists the worker's files", async () => {
        const names = await sessionFs.readdir(at());
        expect(names).toContain("workspace.yaml");
        for (const name of RESERVED) expect(names).not.toContain(name);
        const typed = await sessionFs.readdirWithTypes(at());
        expect(typed.map((entry) => entry.name)).not.toEqual(expect.arrayContaining(RESERVED));
    });

    it("refuses removing or renaming the session's own folder", async () => {
        await expect(sessionFs.rm(at(), true, true)).rejects.toThrow(/own folder/);
        await expect(sessionFs.rm("", true, true)).rejects.toThrow(/own folder/);
        await expect(sessionFs.rename(at(), at("elsewhere"))).rejects.toThrow(/own folder/);
        for (const name of RESERVED) expect(fs.existsSync(path.join(dir, name))).toBe(true);
    });

    it("leaves the session's ordinary files working", async () => {
        await sessionFs.writeFile(at("notes", "plan.md"), "a plan");
        expect(await sessionFs.readFile(at("notes", "plan.md"))).toBe("a plan");
        await sessionFs.appendFile(at("notes", "plan.md"), " and more");
        expect(await sessionFs.readFile(at("notes", "plan.md"))).toBe("a plan and more");
        expect(await sessionFs.exists(at("notes", "plan.md"))).toBe(true);
        expect((await sessionFs.stat(at("notes", "plan.md"))).isFile).toBe(true);
        await sessionFs.rename(at("notes", "plan.md"), at("notes", "plan2.md"));
        expect(await sessionFs.readdir(at("notes"))).toEqual(["plan2.md"]);
        await sessionFs.rm(at("notes"), true, true);
        expect(await sessionFs.exists(at("notes"))).toBe(false);
    });

    it("closes the folder to the runtime while the worker saves it, and opens it again", async () => {
        const release = sessionFs.fence("saved");
        expect(sessionFs.isFenced).toBe(true);
        await expect(sessionFs.writeFile(at("notes.md"), "mid-save")).rejects.toThrow(/cannot run until that finishes/);
        await expect(sessionFs.rm(at("workspace.yaml"), false, true)).rejects.toThrow(/cannot run until that finishes/);
        // Reading changes nothing, so it is never fenced.
        expect(await sessionFs.readFile(at("workspace.yaml"))).toContain("session: yes");
        release();
        expect(sessionFs.isFenced).toBe(false);
        await sessionFs.writeFile(at("notes.md"), "after the save");
        expect(await sessionFs.readFile(at("notes.md"))).toBe("after the save");
    });

    it("opens the folder again only once every fence is released", () => {
        const first = sessionFs.fence("saved");
        const second = sessionFs.fence("restored");
        first();
        expect(sessionFs.isFenced).toBe(true);
        second();
        expect(sessionFs.isFenced).toBe(false);
        // Releasing twice is harmless.
        second();
        expect(sessionFs.isFenced).toBe(false);
    });
});
