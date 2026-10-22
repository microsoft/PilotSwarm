import { getAuthProvider } from "../../packages/app/web/auth.js";
import { startServer } from "../../packages/app/web/server.js";

if (!process.send || process.env.PS_LOCAL_AUTH_MODE !== "proxy") throw new Error("Start this child through the explicit proxy demo runner.");
const provider = getAuthProvider();
if (provider.id !== "proxy" || !provider.enabled || process.env.PORTAL_AUTH_PROXY_MODE !== "jwt") {
    throw new Error("The demo requires the enabled product proxy provider in JWT mode.");
}
await startServer({ host: "127.0.0.1", port: Number(process.env.PORT) });
process.send({ type: "portal-listening" });
