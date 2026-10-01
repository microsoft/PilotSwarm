import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parsePortalExternalViews } from "../config.js";

test("external portal views parse and preserve order", () => {
    assert.deepEqual(
        parsePortalExternalViews(JSON.stringify([
            { id: "workflows", label: "Workflows", url: "/extensions/workflows" },
            { id: "quality", label: "Quality", url: "https://quality.example.test/view" },
        ])),
        [
            { id: "workflows", label: "Workflows", url: "/extensions/workflows" },
            { id: "quality", label: "Quality", url: "https://quality.example.test/view" },
        ],
    );
});

test("external portal views fail loudly on unsafe or ambiguous configuration", () => {
    assert.throws(() => parsePortalExternalViews("{}"), /JSON array/);
    assert.throws(
        () => parsePortalExternalViews('[{"id":"Workflows","label":"Workflows","url":"/view"}]'),
        /lowercase identifier/,
    );
    assert.throws(
        () => parsePortalExternalViews('[{"id":"workflows","label":"Workflows","url":"javascript:alert(1)"}]'),
        /relative, https, or localhost http/,
    );
    assert.throws(
        () => parsePortalExternalViews(JSON.stringify([
            { id: "workflows", label: "Workflows", url: `/${String.fromCharCode(92)}evil.example/view` },
        ])),
        /relative, https, or localhost http/,
    );
    assert.throws(
        () => parsePortalExternalViews('[{"id":"workflows","label":"Workflows","url":"//evil.example/view"}]'),
        /relative, https, or localhost http/,
    );
    assert.throws(
        () => parsePortalExternalViews('[{"id":"workflows","label":"A","url":"/a"},{"id":"workflows","label":"B","url":"/b"}]'),
        /duplicated/,
    );
    assert.throws(
        () => parsePortalExternalViews('[{"id":"one","label":"Workflows","url":"/a"},{"id":"two","label":"WORKFLOWS","url":"/b"}]'),
        /label "WORKFLOWS" is duplicated/,
    );
    assert.throws(
        () => parsePortalExternalViews('[{"id":"one","label":"One","url":"/same"},{"id":"two","label":"Two","url":"/same"}]'),
        /url "\/same" is duplicated/,
    );
});

test("web app hosts configured views in sandboxed work-index tabs", async () => {
    const source = await readFile(
        new URL("../../ui/react/src/web-app.js", import.meta.url),
        "utf8",
    );
    const portalSource = await readFile(
        new URL("../src/App.jsx", import.meta.url),
        "utf8",
    );
    assert.match(source, /tabId: `external:\$\{view\.id\}`/);
    assert.match(source, /ps-external-work-index-frame/);
    assert.match(source, /allow-downloads allow-forms allow-popups allow-same-origin allow-scripts/);
    assert.match(portalSource, /externalViews: portal\?\.externalViews/);
});
