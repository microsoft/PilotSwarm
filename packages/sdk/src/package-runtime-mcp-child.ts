import { pathToFileURL } from "node:url";
import { installPackageSourceSnapshot } from "./package-runtime-snapshot.js";

// Trusted idle bootstrap: the broker records the process identity before asking
// this child to execute immutable package content.
process.on("disconnect", () => process.exit(1));
process.once("message", async (message: any) => {
    if (message?.method !== "start" || Date.now() > message.expiresAt) process.exit(1);
    try {
        installPackageSourceSnapshot(message.snapshot);
        if (Date.now() > message.expiresAt) throw new Error("Admission expired during source snapshot preparation");
        process.argv = [process.execPath, message.path, ...message.args];
        Object.assign(process.env, message.env);
        await import(pathToFileURL(message.path).href);
    } catch { process.exit(1); }
});
