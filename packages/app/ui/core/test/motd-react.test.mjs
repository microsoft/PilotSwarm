import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MotdContent, MotdSplash, MotdAdminPanel } from "../../react/src/motd.js";
import { createMotdAdminState, formatMotdWindow } from "../src/motd.js";

const message = { motdId: "1", fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z",
    bodyMd: "Desktop body", mobileBodyMd: "Phone body", imagePlacement: "beside", createdBy: { subject: "admin" },
    status: "live", dismissalCount: 3 };
const pictures = { desktop: { base64: "AAAA", contentType: "image/png", alt: "Main picture" },
    mobile: { base64: "BBBB", contentType: "image/webp", alt: "Phone picture" } };
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
test("desktop splash uses desktop markdown, picture and selected placement", () => {
    const html = render(MotdContent, { message, pictures });
    assert.match(html, /is-beside/); assert.match(html, /Desktop body/); assert.match(html, /Main picture/);
    assert.doesNotMatch(html, /Phone body/);
});
test("phone always puts the selected mobile picture above its body", () => {
    const html = render(MotdContent, { message, pictures, mobile: true });
    assert.match(html, /is-above/); assert.match(html, /Phone body/); assert.match(html, /Phone picture/);
});
test("phone without mobile body or image falls back to desktop, above", () => {
    const html = render(MotdContent, { message: { ...message, mobileBodyMd: null, imagePlacement: "background" },
        pictures: { desktop: pictures.desktop }, mobile: true });
    assert.match(html, /Desktop body/); assert.match(html, /Main picture/); assert.match(html, /is-above/);
});
test("splash has a modal dialog, separate scroll body and always-present dismissal footer", () => {
    const html = render(MotdSplash, { message, pictures, onDismiss: () => {} });
    assert.match(html, /<dialog/); assert.match(html, /ps-motd-scroll/); assert.match(html, />Got it</);
    assert.match(html, /<footer/); assert.ok(html.includes(formatMotdWindow(message)));
    assert.match(render(MotdSplash, { message, pictures, preview: true, onDismiss: () => {} }), />Close preview</);
});
test("admin tab has today preview, editor, picture limits, history and both delete controls", () => {
    const state = { ...createMotdAdminState(), today: message, history: [message, { ...message, motdId: "2", status: "hidden" }] };
    const html = render(MotdAdminPanel, { controller: {}, state, images: { "1": pictures }, isAdmin: true });
    for (const text of ["Today", "Show splash again", "Phone view", "New message", "2 MB maximum", "Mobile version", "Previous messages", "Hidden by later message", "Publish"]) assert.ok(html.includes(text), text);
    assert.match(html, /Delete current message/); assert.match(html, /Delete message 2/);
    assert.match(html, /Duplicate current message/); assert.match(html, /Duplicate message 2/);
    assert.match(html, /Now|Never - until replaced or deleted/);
    assert.doesNotMatch(html, /datetime-local/);
});
test("non-admin cannot render admin controls even with stale admin data", () => {
    const state = { ...createMotdAdminState(), today: message, history: [{ ...message, motdId: "9", status: "ended" }], expandedIds: ["9"] };
    const html = render(MotdAdminPanel, { controller: {}, state, images: { "1": pictures, "9": pictures }, isAdmin: false, canRead: true });
    for (const text of ["Today", "Previous messages", "Show splash again", "Main picture"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /<form|datetime-local|type="file"|Publish|Delete|Duplicate|New message|people dismissed|by admin/);
    assert.equal(render(MotdAdminPanel, { controller: {}, state, isAdmin: false, canRead: false }), "");
});
test("empty and failed admin states remain explicit", () => {
    const html = render(MotdAdminPanel, { controller: {}, state: { ...createMotdAdminState(), error: "Unable to load messages" }, isAdmin: true });
    assert.match(html, /No message is active today/); assert.match(html, /role="alert"/); assert.match(html, /Unable to load messages/);
});
