#!/usr/bin/env node
/**
 * Differential tests C1 and C3 from docs/proposals/session-workspaces.md.
 *
 * Proves that a session without a workspace looks the same to the model and
 * to the warm-session cache on this tree as on the merge-base with main:
 *
 *   1. Check out the merge-base in a temporary git worktree.
 *   2. Copy this tree's capture files into it, so both sides capture the
 *      same way.
 *   3. Build both trees.
 *   4. On each tree, run:
 *        - test/local/request-capture.test.js (C1): the first model request
 *          of a fixed session, once per native-task mode, normalized.
 *        - test/helpers/fingerprint-capture.mjs (C3): the binding
 *          fingerprint of the same kind of session.
 *   5. Diff each pair. Any difference fails.
 *
 * --mutate proves the check can fail. It compares the merge-base with a copy
 * of the merge-base where spawn_agent declares a `workspace` parameter for
 * every session. That run passes only if every pair differs.
 *
 * Usage:
 *   node scripts/differential-capture.mjs [--base <ref>] [--mutate] [--keep]
 *   npm run test:differential -w packages/sdk
 *
 * Needs PostgreSQL, like the local suite. Uses no model credentials.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = git(["rev-parse", "--show-toplevel"], SDK_DIR);
const SDK_REL = path.relative(REPO_ROOT, SDK_DIR);

/** Files the capture needs, copied from this tree into the other trees. */
const CAPTURE_FILES = [
    "test/helpers/scripted-model.mjs",
    "test/helpers/scripted-workers.js",
    "test/helpers/request-normalizer.mjs",
    "test/helpers/fingerprint-capture.mjs",
    "test/local/request-capture.test.js",
];
const OUTPUTS = ["request-off.txt", "request-sync.txt", "fingerprint.json"];

function git(args, cwd) {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function run(label, command, args, { cwd, env } = {}) {
    process.stdout.write(`\n> [${label}] ${command} ${args.join(" ")}\n`);
    const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`[${label}] ${command} failed with exit code ${result.status}`);
}

function parseArgs(argv) {
    const opts = { base: null, mutate: false, keep: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--base") opts.base = argv[++i];
        else if (argv[i] === "--mutate") opts.mutate = true;
        else if (argv[i] === "--keep") opts.keep = true;
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    return opts;
}

/**
 * The mutation for --mutate: declare an ungated `workspace` parameter on
 * every spawn_agent declaration. Phase 2 must never do this for sessions
 * without a workspace.
 */
function applyMutation(sdkDir) {
    const file = path.join(sdkDir, "src/managed-session.ts");
    const source = fs.readFileSync(file, "utf8");
    let count = 0;
    const mutated = source.replace(/(defineTool\("spawn_agent",\s*\{[\s\S]*?properties:\s*\{)/g, (match) => {
        count++;
        return `${match}\n                    workspace: { type: ["object", "null"], description: "Mutation: workspace for the child." },`;
    });
    if (count === 0) throw new Error("mutation found no spawn_agent declaration to change");
    fs.writeFileSync(file, mutated);
    return count;
}

function addWorktree(dir, ref) {
    git(["worktree", "add", "--detach", dir, ref], REPO_ROOT);
    // Reuse this checkout's installed packages instead of installing again.
    fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
    const sdkModules = path.join(SDK_DIR, "node_modules");
    if (fs.existsSync(sdkModules)) fs.symlinkSync(sdkModules, path.join(dir, SDK_REL, "node_modules"), "dir");
    for (const rel of CAPTURE_FILES) {
        const target = path.join(dir, SDK_REL, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(SDK_DIR, rel), target);
    }
    return path.join(dir, SDK_REL);
}

function capture(label, sdkDir, outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const envFile = path.join(REPO_ROOT, ".env");
    run(label, "npm", ["run", "build"], { cwd: sdkDir });
    run(label, process.execPath, [
        `--env-file-if-exists=${envFile}`,
        path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
        "run", "test/local/request-capture.test.js",
    ], { cwd: sdkDir, env: { PS_CAPTURE_DIR: outDir } });
    run(label, process.execPath, ["test/helpers/fingerprint-capture.mjs", path.join(outDir, "fingerprint.json")], { cwd: sdkDir });
}

function diff(a, b) {
    const result = spawnSync("git", ["diff", "--no-index", "--color=never", a, b], { encoding: "utf8" });
    return result.stdout;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const baseRef = opts.base ?? git(["merge-base", "HEAD", "origin/main"], REPO_ROOT);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ps-differential-"));
    const worktrees = [];
    console.log(`base: ${baseRef}\nwork folder: ${work}`);

    try {
        const baseDir = path.join(work, "base-tree");
        worktrees.push(baseDir);
        const baseSdk = addWorktree(baseDir, baseRef);

        let otherSdk = SDK_DIR;
        let otherLabel = "branch";
        if (opts.mutate) {
            const mutatedDir = path.join(work, "mutated-tree");
            worktrees.push(mutatedDir);
            otherSdk = addWorktree(mutatedDir, baseRef);
            otherLabel = "mutated";
            console.log(`mutation: spawn_agent declares workspace in ${applyMutation(otherSdk)} place(s)`);
        }

        capture("base", baseSdk, path.join(work, "out-base"));
        capture(otherLabel, otherSdk, path.join(work, `out-${otherLabel}`));

        const results = OUTPUTS.map((name) => ({
            name,
            text: diff(path.join(work, "out-base", name), path.join(work, `out-${otherLabel}`, name)),
        }));
        console.log("\n=== differential results ===");
        for (const r of results) {
            console.log(`${r.text ? "DIFFERENT" : "same     "}  ${r.name}`);
            if (r.text) console.log(r.text);
        }

        const differing = results.filter((r) => r.text).length;
        if (opts.mutate) {
            if (differing !== results.length) {
                console.error(`\nFAIL: the mutation changed only ${differing} of ${results.length} captures; the check cannot see it.`);
                process.exitCode = 1;
            } else {
                console.log("\nPASS: every capture detected the mutation.");
            }
        } else if (differing > 0) {
            console.error(`\nFAIL: ${differing} capture(s) differ from the merge-base ${baseRef}.`);
            process.exitCode = 1;
        } else {
            console.log(`\nPASS: sessions without a workspace match the merge-base ${baseRef}.`);
        }
    } finally {
        if (opts.keep) {
            console.log(`kept: ${work}`);
        } else {
            for (const dir of worktrees) {
                try { git(["worktree", "remove", "--force", dir], REPO_ROOT); } catch (error) { console.warn(String(error)); }
            }
            fs.rmSync(work, { recursive: true, force: true });
        }
    }
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
