// Multi-origin portal links: the pure rebasing + clipboard formatting that
// replaces waldemort's bundle monkey patch.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPortalEntryLink, buildPortalLinks, formatPortalLinksForCopy } from "../src/portal-links.js";

const TWO = [
    { label: "Corporate", origin: "https://corp.example.com" },
    { label: "Private/VPN", origin: "https://vpn.example.com" },
];

test("session, artifact and canvas entry links keep the configured path before rebasing origins", () => {
    const location = { origin: "https://portal.example.invalid", pathname: "/existing/deep/path" };
    for (const entry of ["/", "/portal/", "/tools/agents/"]) {
        for (const query of [
            "session=fixture", "session=fixture&artifact=report%20one.html&view=full",
            "session=fixture&view=canvas&slot=2&max=1&show_chrome=false", "canvasShare=fixture-value",
        ]) {
            const link = buildPortalEntryLink(location, query, entry);
            assert.equal(link, `${location.origin}${entry}?${query}`);
            for (const [index, alternate] of buildPortalLinks(`${link}#section`, TWO).entries()) {
                assert.equal(alternate.url, `${TWO[index].origin}${entry}?${query}#section`);
            }
        }
    }
    assert.equal(buildPortalEntryLink(location, "session=fixture"), `${location.origin}${location.pathname}?session=fixture`);
});

test("portal entry links do not inherit old share capabilities or permit an external entry", () => {
    const location = { origin: "https://portal.example.invalid", pathname: "/portal/", search: "?canvasShare=old-value", hash: "#old" };
    assert.equal(buildPortalEntryLink(location, "session=fixture"), "https://portal.example.invalid/portal/?session=fixture");
    for (const entry of ["//elsewhere.invalid/", "https://elsewhere.invalid/", "/a/../portal/", "/portal/?canvasShare=old", "/portal/#old"]) {
        assert.throws(() => buildPortalEntryLink(location, "session=fixture", entry), /Portal entry/u);
    }
});

test("with two origins, every link is rebased onto each, labeled, order preserved", () => {
    const links = buildPortalLinks("https://whatever.host/?session=abc&view=canvas&slot=2&max=1#frag", TWO);
    assert.deepEqual(links, [
        { label: "Corporate", url: "https://corp.example.com/?session=abc&view=canvas&slot=2&max=1#frag" },
        { label: "Private/VPN", url: "https://vpn.example.com/?session=abc&view=canvas&slot=2&max=1#frag" },
    ]);
});

test("the canvas share token URL rebases identically — one token, N doors", () => {
    const links = buildPortalLinks("http://localhost:3001/?canvasShare=tok_abc", TWO);
    assert.equal(links[0].url, "https://corp.example.com/?canvasShare=tok_abc");
    assert.equal(links[1].url, "https://vpn.example.com/?canvasShare=tok_abc");
});

test("no config, empty config, or ONE origin: the original URL passes through unlabeled", () => {
    for (const origins of [undefined, [], [TWO[0]]]) {
        assert.deepEqual(buildPortalLinks("https://x.test/?a=1", origins), [{ label: null, url: "https://x.test/?a=1" }]);
    }
});

test("a malformed URL degrades to passthrough, never a throw", () => {
    assert.deepEqual(buildPortalLinks("not a url", TWO), [{ label: null, url: "not a url" }]);
    assert.deepEqual(buildPortalLinks("", TWO), [{ label: null, url: "" }]);
});

test("entries missing label or origin are ignored, and dropping to one means passthrough", () => {
    const sloppy = [{ label: "Ok", origin: "https://a.test" }, { label: "", origin: "https://b.test" }, { origin: "https://c.test" }];
    assert.deepEqual(buildPortalLinks("https://x.test/p", sloppy), [{ label: null, url: "https://x.test/p" }]);
});

test("clipboard format: bare URL alone; labeled lines when multiple", () => {
    assert.equal(formatPortalLinksForCopy([{ label: null, url: "https://x.test/p" }]), "https://x.test/p");
    assert.equal(
        formatPortalLinksForCopy(buildPortalLinks("https://x.test/p?q=1", TWO)),
        "Corporate: https://corp.example.com/p?q=1\nPrivate/VPN: https://vpn.example.com/p?q=1",
    );
});
