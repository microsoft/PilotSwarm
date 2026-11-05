import { uploadHttpFixture } from "./workspace-upload-harness.mjs";
const fixture = await uploadHttpFixture();
process.send({ url: fixture.direct });
process.on("message", async (message) => {
    if (message === "warm") { global.gc(); process.send({ warm: true }); }
    if (message === "stop") { await fixture.close(); process.disconnect(); }
});
