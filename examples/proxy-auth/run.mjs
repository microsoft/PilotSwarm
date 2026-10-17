import { fork } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProxyAuthExample } from "./proxy.mjs";

function options(args) {
    const result = { demo: false, port: 3001, portalPort: 3002, basePath: "/portal", sessionTtlSeconds: 900 };
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (key === "--demo") { result.demo = true; continue; }
        if (!["--port", "--portal-port", "--base-path", "--session-ttl"].includes(key) || !args[i + 1]) {
            throw new Error("Use --demo [--port 3001] [--portal-port 3002] [--base-path /portal] [--session-ttl 900].");
        }
        const value = args[++i];
        if (key === "--base-path") result.basePath = value;
        else {
            const name = { "--port": "port", "--portal-port": "portalPort", "--session-ttl": "sessionTtlSeconds" }[key];
            result[name] = Number(value);
        }
    }
    for (const port of [result.port, result.portalPort]) {
        if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Demo ports must be integers from 1024 to 65535.");
    }
    return result;
}

export async function runProxyAuthDemo(args = process.argv.slice(2), { env = process.env } = {}) {
    const config = options(args);
    if (!config.demo) throw new Error("--demo explicitly enables passwordless local personas.");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    await access(new URL("../../packages/app/web/dist/index.html", import.meta.url));
    const proxy = await createProxyAuthExample({
        demo: true, publicOrigin: `http://127.0.0.1:${config.port}`, upstreamOrigin: `http://127.0.0.1:${config.portalPort}`,
        basePath: config.basePath, sessionTtlSeconds: config.sessionTtlSeconds,
    });
    let child;
    let closed = false;
    let closing;
    const close = () => closing ||= (async () => {
        closed = true;
        await proxy.close();
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise((resolve) => {
                const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
                child.once("exit", () => { clearTimeout(deadline); resolve(); });
                child.kill("SIGTERM");
            });
        }
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    })();
    const onSignal = () => { close().catch(() => { console.error("[proxy-auth-demo] Shutdown failed."); process.exitCode = 1; }); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
        await proxy.listen();
        if (closed) throw new Error("Demo stopped during startup.");
        child = fork(new URL("./portal-child.mjs", import.meta.url), [], {
            cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"],
            env: {
                ...env, ...proxy.portalEnv,
                PS_LOCAL_AUTH_MODE: "proxy", PORTAL_TUI_MODE: "local",
                TLS_CERT_PATH: "", TLS_KEY_PATH: "",
            },
        });
        child.once("exit", (code, signal) => {
            if (!closed) {
                console.error(`[proxy-auth-demo] Portal child exited (${code ?? signal}).`);
                process.exitCode = 1;
                onSignal();
            }
        });
        await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => finish(new Error("Portal startup timed out.")), 60_000);
            const onMessage = (message) => { if (message?.type === "portal-listening") finish(); };
            const onExit = () => finish(new Error("Portal exited before readiness."));
            const onError = () => finish(new Error("Portal child could not start."));
            function finish(error) {
                clearTimeout(deadline);
                child.off("message", onMessage);
                child.off("exit", onExit);
                child.off("error", onError);
                if (error) reject(error); else resolve();
            }
            child.on("message", onMessage);
            child.once("exit", onExit);
            child.once("error", onError);
        });
        await proxy.activate();
        if (closed) throw new Error("Demo stopped during startup.");
        console.log(`[proxy-auth-demo] Ready: http://127.0.0.1:${config.port}${proxy.paths.entryPath}`);
        console.log("[proxy-auth-demo] Local personas only; not a production identity service. Stop this process to stop both servers.");
        return { close, proxy, child };
    } catch (error) {
        await close();
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runProxyAuthDemo().catch((error) => {
        console.error(`[proxy-auth-demo] Startup failed: ${error.message}`);
        process.exitCode = 1;
    });
}
