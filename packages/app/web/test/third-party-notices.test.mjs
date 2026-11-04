// The portal's third-party notices name every component whose code ships in the browser bundle, including one that
// another package carries already bundled inside its own dist: @dagrejs/dagre's dist includes @dagrejs/graphlib with no
// import, so the license plugin never lists it by itself (batch 5 notices follow-up).
//
// Run: node --test packages/app/web/test/third-party-notices.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_COMPONENTS, ELECTED_LICENSES, bundledComponents, installedComponent, thirdPartyNotices } from "../third-party-notices.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../package-lock.json"), "utf8"));
const locked = name => lock.packages[`node_modules/${name}`]?.version;

/** A dependency as rollup-plugin-license lists it. */
const listed = (name, extra = {}) => ({ name, version: locked(name) ?? "0.0.0", license: "MIT", repository: null, licenseText: `${name} license`, noticeText: null, ...extra });

test("dagre's bundled graphlib is named, at its locked version, with its own MIT license text", () => {
    const text = thirdPartyNotices([listed("@dagrejs/dagre"), listed("react")]);
    const version = locked("@dagrejs/graphlib");
    assert.equal(version, "4.0.6");
    const section = text.split("=".repeat(78)).find(part => part.trimStart().startsWith("@dagrejs/graphlib "));
    assert.ok(section, "graphlib has its own section");
    assert.match(section, new RegExp(`^\\n@dagrejs/graphlib ${version.replace(/\./g, "\\.")}\\nLicense: MIT\\nSource: https://github\\.com/dagrejs/graphlib\\.git\\n`));
    assert.match(section, /Copyright \(c\) 2012-2014 Chris Pettitt/);
    assert.match(section, /Permission is hereby granted, free of charge/);
    // Sorted with the others, each listed once.
    const names = [...text.matchAll(/^={78}\n(\S+) /gm)].map(match => match[1]);
    assert.deepEqual([...names].sort(), ["@dagrejs/dagre", "@dagrejs/graphlib", "react"]);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("graphlib is added only when dagre ships, and never twice", () => {
    assert.ok(!thirdPartyNotices([listed("react")]).includes("@dagrejs/graphlib"));
    assert.deepEqual(bundledComponents([listed("react")]), []);
    const both = thirdPartyNotices([listed("@dagrejs/dagre"), listed("@dagrejs/graphlib", { licenseText: "listed by the plugin" })]);
    assert.equal(both.match(/^@dagrejs\/graphlib /gm)?.length, 1);
    assert.ok(both.includes("listed by the plugin"));
});

test("the installed package is read as the plugin would list it; a package that is not installed is skipped", () => {
    const graphlib = installedComponent("@dagrejs/graphlib");
    assert.equal(graphlib.name, "@dagrejs/graphlib");
    assert.equal(graphlib.version, locked("@dagrejs/graphlib"));
    assert.equal(graphlib.license, "MIT");
    assert.match(graphlib.licenseText, /^Copyright \(c\) 2012-2014 Chris Pettitt/);
    assert.equal(installedComponent("@pilotswarm/no-such-package"), null);
    assert.deepEqual(BUNDLED_COMPONENTS.map(item => [item.name, item.within]), [["@dagrejs/graphlib", "@dagrejs/dagre"]]);
});

test("the notices keep their header, elected licenses and sources as before", () => {
    const text = thirdPartyNotices([listed("dompurify", { license: "(MPL-2.0 OR Apache-2.0)", repository: { url: "https://github.com/cure53/DOMPurify" } })]);
    assert.ok(text.startsWith("THIRD-PARTY SOFTWARE NOTICES\n\nThe PilotSwarm web portal includes the following third-party software.\n"));
    assert.match(text, /\ndompurify [^\n]+\nLicense: \(MPL-2\.0 OR Apache-2\.0\)\nUsed under: Apache-2\.0\nSource: https:\/\/github\.com\/cure53\/DOMPurify\n/);
    assert.equal(ELECTED_LICENSES.dompurify, "Apache-2.0");
});
