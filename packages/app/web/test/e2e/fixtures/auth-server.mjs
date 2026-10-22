import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createAuthTestServer() {
    const cacheDir = await mkdtemp(join(tmpdir(), "pilotswarm-auth-vite-"));
    let server;
    try {
        server = await createServer({
            configFile: false,
            cacheDir,
            root: fileURLToPath(new URL("../../../", import.meta.url)),
            publicDir: false,
            plugins: [react()],
            optimizeDeps: { entries: ["test/e2e/fixtures/auth-browser.html"] },
            resolve: { alias: {
                "@azure/msal-browser": fileURLToPath(new URL("./msal-browser.mjs", import.meta.url)),
                "pilotswarm/ui-core": fileURLToPath(new URL("../../../../ui/core/src/index.js", import.meta.url)),
                "pilotswarm/ui-react": fileURLToPath(new URL("../../../../ui/react/src/index.js", import.meta.url)),
                "pilotswarm-sdk/api": fileURLToPath(new URL("../../../../../sdk/api/index.js", import.meta.url)),
            } },
            server: { host: "127.0.0.1", port: 0, hmr: false },
        });
        await server.listen();
    } catch (error) {
        try {
            await server?.close();
        } finally {
            await rm(cacheDir, { recursive: true, force: true });
        }
        throw error;
    }
    const close = server.close.bind(server);
    server.close = async () => {
        try {
            await close();
        } finally {
            await rm(cacheDir, { recursive: true, force: true });
        }
    };
    return server;
}
