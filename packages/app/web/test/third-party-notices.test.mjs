/**
 * The bundle's THIRD-PARTY-NOTICES.txt carries the full license text of every
 * asset that ships from the source tree (today: the Sora and JetBrains Mono
 * fonts, both SIL OFL 1.1),
 * not only the npm packages. Needs a built bundle: npm run build:web.
 *
 * Run: node --test web/test/third-party-notices.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const notices = new URL("THIRD-PARTY-NOTICES.txt", dist);
const built = existsSync(new URL("index.html", dist));

// Skips only when there is no bundle at all; a bundle without the notice fails.
test("the Sora fonts ship with the full SIL Open Font License text", { skip: !built && "no built bundle (run npm run build:web)" }, () => {
    assert.ok(existsSync(notices), "a built bundle must carry THIRD-PARTY-NOTICES.txt");
    const text = readFileSync(notices, "utf8");
    assert.match(text, /Sora \(fonts for the Horizon Dawn theme\)\nLicense: OFL-1\.1/);
    assert.match(text, /Copyright 2019 The Sora Project Authors/);
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(text, /PERMISSION & CONDITIONS/);
    const fonts = readdirSync(new URL("assets/", dist)).filter((name) => /^sora-.*\.woff2$/.test(name));
    assert.ok(fonts.length >= 1, "the bundle ships the Sora font files this notice covers");
});

test("JetBrains Mono ships with the full SIL Open Font License text", { skip: !built && "no built bundle (run npm run build:web)" }, () => {
    assert.ok(existsSync(notices), "a built bundle must carry THIRD-PARTY-NOTICES.txt");
    const text = readFileSync(notices, "utf8");
    assert.match(text, /JetBrains Mono \(the portal's monospace font\)\nLicense: OFL-1\.1/);
    assert.match(text, /Copyright 2020 The JetBrains Mono Project Authors/);
    const fonts = readdirSync(new URL("assets/", dist)).filter((name) => /^jetbrains-mono-.*\.woff2$/.test(name));
    assert.ok(fonts.length >= 4, "the bundle ships the JetBrains Mono font files this notice covers");
});
