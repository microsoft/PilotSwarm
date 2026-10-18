import { pathToFileURL } from "node:url";

// Trusted idle bootstrap: the broker records the process identity before asking
// this child to execute immutable package content.
process.on("disconnect", () => process.exit(1));
process.once("message", async (message: any) => {
    if (message?.method !== "start" || Date.now() > message.expiresAt) process.exit(1);
    try {
        process.argv = [process.execPath, message.path, ...message.args];
        Object.assign(process.env, message.env);
        await import(pathToFileURL(message.path).href);
    } catch { process.exit(1); }
});
