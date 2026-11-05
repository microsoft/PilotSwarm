import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// A release consumer gets real files, not a workspace link. Reuse the checked-in
// dependency versions so a fresh install need not query unlocked registry metadata.
function consumerLock(source, manifest, archive, integrity) {
    const packages = { "": { name: "native-consumer", version: "1.0.0", dependencies: { "pilotswarm-sdk": `file:${archive}` } },
        "node_modules/pilotswarm-sdk": { ...manifest, resolved: `file:${archive}`, integrity } };
    delete packages["node_modules/pilotswarm-sdk"].scripts;
    delete packages["node_modules/pilotswarm-sdk"].devDependencies;
    const queued = new Set();
    function visit(owner, definition) {
        for (const name of new Set([...Object.keys(definition.dependencies ?? {}), ...Object.keys(definition.optionalDependencies ?? {}),
            ...Object.keys(definition.peerDependencies ?? {}).filter(key => !definition.peerDependenciesMeta?.[key]?.optional)])) {
            let directory = owner, found;
            while (true) {
                const candidate = (directory ? directory + "/" : "") + "node_modules/" + name;
                if (source.packages[candidate] && !source.packages[candidate].link) { found = candidate; break; }
                if (!directory) break;
                directory = path.posix.dirname(directory);
                if (directory === ".") directory = "";
            }
            assert.ok(found, `Locked runtime dependency missing: ${owner} -> ${name}`);
            if (queued.has(found)) continue;
            queued.add(found);
            const target = found.startsWith("packages/sdk/") ? "node_modules/pilotswarm-sdk/" + found.slice("packages/sdk/".length) : found;
            packages[target] = source.packages[found];
            visit(found, source.packages[found]);
        }
    }
    visit("packages/sdk", manifest);
    return { name: "native-consumer", version: "1.0.0", lockfileVersion: 3, requires: true, packages };
}

async function installedDependencyManifest(directory, definition) {
    try { return JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")); }
    catch (error) {
        if (definition.optional && error.code === "ENOENT") return undefined;
        throw error;
    }
}

test("absent optional platform packages remain npm's responsibility; required inputs fail explicitly", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps-consumer-optional-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.equal(await installedDependencyManifest(path.join(root, "uninstalled-platform"), { optional: true }), undefined);
    await assert.rejects(installedDependencyManifest(path.join(root, "missing-required"), {}), { code: "ENOENT" });
});

test("a fresh tarball installation uses only shipped public exports, types and host CLI", { timeout: 300_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps-public-native-"));
    const children = [];
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once("exit", resolve));
            child.kill();
            await exited;
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    const sdk = fileURLToPath(new URL("../..", import.meta.url));
    await fs.copyFile(new URL("../fixtures/compute-native-consumer/consumer.mjs", import.meta.url), path.join(root, "consumer.mjs"));
    await fs.copyFile(new URL("../fixtures/compute-native-consumer/provider.mts", import.meta.url), path.join(root, "provider.mts"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ["path", "systemroot", "windir", "temp", "tmp", "comspec", "pathext"].includes(key.toLowerCase())));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    for (const name of ["user.npmrc", "global.npmrc"]) await fs.writeFile(path.join(root, name), "");
    Object.assign(env, {
        HOME: home, USERPROFILE: home, COPILOT_HOME: home,
        NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"),
        NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"),
        NPM_CONFIG_CACHE: process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "npm-cache") : path.join(os.homedir(), ".npm"),
    });
    const npm = [
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
        path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    let npmCli;
    for (const candidate of npm) { try { await fs.access(candidate); npmCli = candidate; break; } catch (error) { if (error.code !== "ENOENT") throw error; } }
    assert.ok(npmCli, "A Node installation with npm is required for the fresh package fixture");
    async function run(args, cwd = root, expectedCode = 0) {
        const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        let output = "", errors = "";
        child.stdout.on("data", bytes => { output += bytes; });
        child.stderr.on("data", bytes => { errors += bytes; });
        const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
        assert.equal(code, expectedCode, output + errors);
        return expectedCode === 0 ? output : output + errors;
    }
    const [packed] = JSON.parse(await run([npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", root], sdk));
    const shipped = new Set(packed.files.map(file => file.path));
    for (const file of ["LICENSE", "dist/index.js", "dist/index.d.ts", "dist/compute-host-cli.js",
        "dist/compute-native-state.js", "dist/compute-native-state.d.ts", "dist/compute-native-client.js",
        "api/index.js", "plugins/system/agents/default.agent.md"]) {
        assert.ok(shipped.has(file), `Required public package asset missing: ${file}`);
    }
    assert.equal([...shipped].some(file => /(?:^|\/)\.env(?:$|\.)|\.model_providers\.json$/.test(file)), false);
    const sdkManifest = JSON.parse(await fs.readFile(path.join(sdk, "package.json"), "utf8"));
    const sourceLock = JSON.parse(await fs.readFile(path.join(sdk, "..", "..", "package-lock.json"), "utf8"));
    const archive = await fs.readFile(path.join(root, packed.filename));
    const lock = consumerLock(sourceLock, sdkManifest, packed.filename, "sha512-" + createHash("sha512").update(archive).digest("base64"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "native-consumer", version: "1.0.0",
        private: true, type: "module", dependencies: lock.packages[""].dependencies }));
    await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
    const cache = createRequire(npmCli)("cacache");
    const compatible = (values, value) => !values || (!values.includes("!" + value)
        && (!values.some(item => !item.startsWith("!")) || values.includes(value)));
    const locallyRestored = [];
    for (const [target, definition] of Object.entries(lock.packages)) {
        if (!target || target === "node_modules/pilotswarm-sdk" || !definition.integrity
            || !compatible(definition.os, process.platform) || !compatible(definition.cpu, process.arch)
            || await cache.get.hasContent(path.join(env.NPM_CONFIG_CACHE, "_cacache"), definition.integrity)) continue;
        const source = target.startsWith("node_modules/pilotswarm-sdk/node_modules/")
            ? "packages/sdk/" + target.slice("node_modules/pilotswarm-sdk/".length) : target;
        const directory = path.resolve(sdk, "..", "..", ...source.split("/"));
        const installedManifest = await installedDependencyManifest(directory, definition);
        if (!installedManifest) continue;
        assert.equal(installedManifest.version, definition.version, "Local dependency restoration must retain the locked version");
        const destination = path.join(root, "dependency-tarballs", String(locallyRestored.length));
        await fs.mkdir(destination, { recursive: true });
        const key = "pilotswarm-native-consumer-repack:" + definition.integrity;
        const cached = await cache.get.info(path.join(env.NPM_CONFIG_CACHE, "_cacache"), key);
        let file;
        if (cached) {
            assert.equal(cached.metadata.version, definition.version);
            assert.equal(cached.metadata.name, installedManifest.name);
            file = path.join(destination, "dependency.tgz");
            await fs.writeFile(file, (await cache.get(path.join(env.NPM_CONFIG_CACHE, "_cacache"), key)).data);
        } else {
            console.log(`  restoring locked public package ${installedManifest.name}@${installedManifest.version}`);
            const [dependency] = JSON.parse(await run([npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", destination], directory));
            file = path.join(destination, dependency.filename);
            await cache.put(path.join(env.NPM_CONFIG_CACHE, "_cacache"), key, await fs.readFile(file),
                { metadata: { name: installedManifest.name, version: definition.version } });
        }
        definition.resolved = "file:" + path.relative(root, file).split(path.sep).join("/");
        definition.integrity = "sha512-" + createHash("sha512").update(await fs.readFile(file)).digest("base64");
        locallyRestored.push(`${installedManifest.name}@${installedManifest.version}`);
    }
    await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
    console.log(JSON.stringify({ dependencyRestore: "locked installed public packages", locallyRestored }));
    await run([npmCli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
        "--registry=https://registry.npmjs.org"]);
    const installed = path.join(root, "node_modules", "pilotswarm-sdk");
    assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(path.join(installed, "LICENSE"), "utf8"), await fs.readFile(path.join(sdk, "LICENSE"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
    assert.match(await run([path.join(installed, manifest.bin["pilotswarm-compute-host"]), "--help"], root, 2), /native-module/);
    console.log(JSON.stringify({ packageFixture: "fresh tarball", version: manifest.version, shippedFiles: shipped.size,
        sha256: createHash("sha256").update(await fs.readFile(path.join(root, packed.filename))).digest("hex") }));
    const compiler = fileURLToPath(new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url));
    const typeRoots = fileURLToPath(new URL("../../../../node_modules/@types", import.meta.url));
    const check = spawn(process.execPath, [compiler, "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
        "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", typeRoots, "provider.mts"],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(check);
    let diagnostics = "";
    check.stdout.on("data", bytes => { diagnostics += bytes; });
    check.stderr.on("data", bytes => { diagnostics += bytes; });
    const typed = await new Promise((resolve, reject) => { check.once("error", reject); check.once("exit", resolve); });
    assert.equal(typed, 0, diagnostics);
    const child = spawn(process.execPath, ["consumer.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { output += bytes; });
    const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /public consumer: native prepare\/capture\/CAS\/cold restore passed/);
});
