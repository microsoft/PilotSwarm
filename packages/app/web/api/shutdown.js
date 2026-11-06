/**
 * The portal's shutdown (FU-12): one deadline for the whole of it, so a TERM ends the process whatever its clients and the
 * database do. Before, shutdown() closed the WebSocket clients, stopped the runtime and then closed the server, with no
 * deadline and no exit: a browser's WebSocket that reconnected while the runtime stopped (the server still listened), or
 * an HTTP request still in flight, kept the process alive after the server stopped listening.
 *
 * Order: stop accepting (the HTTP server and each WebSocket server, so a late upgrade gets 503); idle keep-alive
 * connections end; each WebSocket client gets a close frame (1001, going away); the relays and the runtime stop, each
 * bounded; then the remaining connections get until the deadline to end, and are cut at it. A step's failure is logged
 * and never keeps the shutdown from ending.
 */

/** The portal's shutdown deadline when PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS does not set it: inside Kubernetes' default 30 s grace. */
export const PORTAL_SHUTDOWN_TIMEOUT_DEFAULT_MS = 20_000;

/** The deadline from the environment (PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS), else the default. */
export function portalShutdownTimeoutMs(env = process.env) {
    const value = Number.parseInt(env.PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS || "", 10);
    return Number.isFinite(value) && value >= 0 ? value : PORTAL_SHUTDOWN_TIMEOUT_DEFAULT_MS;
}

/**
 * A shutdown function for `server` and its `socketServers` (ws WebSocketServers in noServer mode). `steps` are named
 * async stops (the relays, the runtime) run after the server stops accepting. Calling it again returns the same
 * promise. It resolves with whether the deadline cut anything; it never rejects.
 */
export function createPortalShutdown({ server, socketServers = [], steps = [], timeoutMs = portalShutdownTimeoutMs(), log = console }) {
    let running = null;
    return function shutdown() {
        running ??= (async () => {
            const deadline = Date.now() + Math.max(0, timeoutMs);
            const late = [];
            const untilDeadline = (promise, name) => {
                let timer;
                return Promise.race([
                    Promise.resolve(promise).then(() => true, (error) => {
                        log.warn?.(`[portal] shutdown: ${name} failed: ${error?.message ?? error}`);
                        return true;
                    }),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
                        timer.unref?.();
                    }),
                ]).then((done) => {
                    clearTimeout(timer);
                    if (!done) late.push(name);
                });
            };
            const serverClosed = new Promise((resolve) => {
                try {
                    server.close(() => resolve());
                } catch {
                    resolve();
                }
            });
            for (const socketServer of socketServers) {
                try { socketServer.close(); } catch {}
            }
            try { server.closeIdleConnections?.(); } catch {}
            for (const socketServer of socketServers) {
                for (const client of socketServer.clients ?? []) {
                    try { client.close(1001, "The portal is shutting down."); } catch {}
                }
            }
            for (const step of steps) {
                await untilDeadline(Promise.resolve().then(step.stop), step.name);
            }
            await untilDeadline(serverClosed, "open connections");
            // The deadline: what is still open is cut, so nothing keeps the process alive.
            let cut = 0;
            for (const socketServer of socketServers) {
                for (const client of socketServer.clients ?? []) {
                    cut += 1;
                    try { client.terminate(); } catch {}
                }
            }
            try { server.closeAllConnections?.(); } catch {}
            if (late.length > 0) {
                log.error?.(`[portal] shutdown: ${late.join(", ")} did not finish within ${timeoutMs} ms; closing ${cut} WebSocket(s) and every open connection, and exiting`);
            }
            return late.length > 0;
        })();
        return running;
    };
}

/**
 * Exit on SIGINT and SIGTERM after `shutdown`, at the deadline at the latest: a backstop timer (the deadline plus 2 s)
 * exits even if the shutdown itself were stuck. `exit` is process.exit, given for tests.
 */
export function exitOnSignals(shutdown, { timeoutMs = portalShutdownTimeoutMs(), exit = (code) => process.exit(code), target = process } = {}) {
    const onSignal = () => {
        const backstop = setTimeout(() => exit(1), Math.max(0, timeoutMs) + 2_000);
        backstop.unref?.();
        Promise.resolve()
            .then(shutdown)
            .catch(() => {})
            .finally(() => {
                clearTimeout(backstop);
                exit(0);
            });
    };
    target.on("SIGINT", onSignal);
    target.on("SIGTERM", onSignal);
    return onSignal;
}
