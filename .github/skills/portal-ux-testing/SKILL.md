---
name: portal-ux-testing
description: Test a browser portal UX change in every layout mode it can meet - reading column on and off, live and after a reload, desktop and phone, Chromium and WebKit, with and without a canvas. Load before you call a portal layout, chat, session-list or canvas change done.
---

# Portal UX testing

A portal change that looks right in one mode often breaks in another. Most
layout regressions found by the owner were in a mode nobody tested: the
reading column turned off, a canvas that popped up during a live turn, a
phone, or Safari. Test the change in each mode below that it can reach, and
say which ones you covered.

## The mode matrix

| Axis | Test both | Why |
|---|---|---|
| Reading column (Settings > Appearance) | `chatReading.on` true **and** false | With it on, chat content is held to a fixed column. With it off, wide content (tool cards, code, tables, artifact cards) is free to size against the pane, and grid tracks see different minimum widths. A fix proven with one setting proves nothing about the other. |
| Live vs reloaded | During a live turn **and** after a page reload | Live state (a canvas that pops up mid-turn, streaming cards, message previews) takes different code paths from state hydrated from the profile and history. "Broken until refresh" means only the reloaded path was tested. |
| Settings round trip | Before **and** after opening and closing Settings (the Admin Console) | The console replaces the whole workspace and puts it back. Anything bound to the old elements (measurements, observers, refs) goes stale until a reload. Changing a setting such as the reading column always takes this path, so test a setting by changing it live, not only by seeding it. |
| Session switching | Switch to another session **and** back, more than once | Per-session view state (canvas open, remembered canvas width, scroll anchor) is saved on leave and restored on return. |
| Canvas | Closed, open at default width, and a remembered width wider than the window can give | Remembered widths are per session and can exceed the window. Nothing else may pay for them: the session list keeps its width and chat keeps its floor. |
| Device class | Desktop (1280, 1440, 1920) **and** phone (390x844) | The phone has its own workspace: the session list is a slide-over, Settings > Appearance carries phone-only rows. Desktop settings such as the reading column must not leak to the phone. |
| Browser | Chromium **and** WebKit | iPhone and Mac Safari are WebKit. A spec opts in with `test.use({ browserName: process.env.PS_TEST_BROWSER \|\| "chromium" })`; run it again with `PS_TEST_BROWSER=webkit`. Phone device presets (`devices["iPhone 14 Pro"]`) already run WebKit. |
| Theme | One modern theme and one retro theme (for example `cobalt2` and `win95`) | Retro themes change borders, fonts and control sizes, and so the geometry. |

Not every change reaches every axis. A phone-only change does not need the
reading column; a session-list change does. When you skip an axis, say why.

## Setting the modes in a spec

Seed profile settings through the profile route, as `chat-rail-fit.spec.mjs`
does, and stub the settings write so a test never stores a profile:

```js
await page.route("**/api/v1/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: {
        themeId: "cobalt2",
        chatReading: { on: reading, width: 1100, align: "left", pad: 20 },
    } } } });
    if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: {} } });
    return route.fallback();
});
```

Loop the test over both values rather than writing two specs:

```js
for (const reading of [false, true]) test(`... (reading column ${reading ? "on" : "off"})`, async ({ page }) => { /* ... */ });
```

For live behaviour, deliver the event the way production does (the events
route or the live plane) after the page has loaded, measure, then reload and
measure again. Assert the two agree.

## What to assert

Assert properties, not pixels: computed styles and `getBoundingClientRect()`
geometry. For layout stability, record the measurement in each state and
assert it holds, for example the session list width across canvas and
non-canvas sessions, live and after reload, with the reading column on and
off. A fix needs a test that fails without it: run the new test against the
old code once and report that it failed.

## On a deployed test environment

Specs run against the stub server. Before you call a layout change ready, also
check the deployed build in a real browser with the owner's own profile shape
(per-session canvas widths, reading column setting, long session list), in
both reading-column modes, live and after reload. Route the profile-settings
write to a stub unless the run is meant to change the profile.

## Report

State the modes covered in the result, for example:

| Mode | Covered |
|---|---|
| Reading column on / off | both |
| Live / reloaded | both |
| Desktop / phone | desktop only (change is desktop-only) |
| Chromium / WebKit | both |
