// Session turn control in the portal: the data-testid contract of plan C3
// (the parent's UX pass asserts and screenshots these selectors). A fake
// transport answers every call: the hermetic stub server plus routed Web API
// calls and a routed WebSocket for live session events. Every selector and
// every attribute value of the contract table is reached here, in the single
// session view, in the Master of Agents dashboard and in the phone focus views.
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const SID = "11111110-2222-3333-4444-555555555550";
const SID2 = "11111111-2222-3333-4444-555555555551";
const T0 = 1785000000000;
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 0 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const ev = (seq, eventType, data) => ({ sessionId: SID, seq, eventType, createdAt: T0 + seq * 1000, data });

/**
 * A scripted fake Web API and live channel for `sessions`
 * (id -> { title, detail, events }), each with a running turn that accepts
 * controls. Every Steer, Stop and send is recorded with the session id of its
 * request path. `handlers` answer the Stop/Steer/send routes (a function gets
 * the route and the request body). `profile` is the viewer's profile settings
 * (a MoA layout); without it the stub server answers.
 */
async function fakePortal(page, { sessions, steering = true, canWrite = true, handlers = {}, profile = null }) {
    const state = { sessions: {}, steers: [], stops: [], sends: [] };
    for (const [id, session] of Object.entries(sessions)) {
        state.sessions[id] = {
            detail: { sessionId: id, title: session.title, status: "running", activeTurnIndex: 3, turnHigh: 3, acceptsTurnControl: true,
                model: "github-copilot:claude-sonnet-5", createdAt: T0, updatedAt: T0, statusVersion: 1, ...session.detail },
            events: [...(session.events || [])],
        };
    }
    // socket -> the session ids it subscribed; session id -> live subscriptions.
    const sockets = new Map();
    const liveSubscriptions = new Map();
    await page.routeWebSocket("**/api/v1/ws", (ws) => {
        const subscribed = new Set();
        sockets.set(ws, subscribed);
        ws.onClose(() => sockets.delete(ws));
        ws.onMessage((raw) => {
            const message = JSON.parse(raw);
            if (message.type === "subscribeSession" || message.type === "subscribeLive") subscribed.add(message.sessionId);
            if (message.type === "unsubscribeSession") subscribed.delete(message.sessionId);
            if (message.type === "subscribeLive") liveSubscriptions.set(message.sessionId, (liveSubscriptions.get(message.sessionId) || 0) + 1);
        });
    });
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const answer = (result) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
        const fail = (status, code, message = code) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code, message } }) });
        if (path.endsWith("/management/users/me/features")) {
            return answer({ userId: 1, flags: [{ featureKey: "sessions.steering", effective: steering, supported: true }] });
        }
        if (profile && path.endsWith("/me/profile/settings")) {
            profile = request.postDataJSON().settings;
            return answer({ profileSettings: profile });
        }
        if (profile && path.endsWith("/me/profile")) return answer({ isAdmin: false, profileSettings: profile });
        if (path.endsWith("/management/sessions")) return answer({ sessions: Object.values(state.sessions).map((session) => session.detail), hasMore: false });
        const [, sessionId, action] = /\/sessions\/([^/]+)(\/.*)?$/.exec(path) || [];
        const session = state.sessions[sessionId];
        if (!session) return route.fallback();
        if (!action) return answer(session.detail);
        if (action === "/access") {
            return answer({ visibility: "private", relation: canWrite ? "owner" : "collaborator", canWrite, canManage: canWrite,
                owner: { provider: "none", subject: "owner", displayName: "Owner" } });
        }
        if (action === "/events" && path.includes("/management/sessions/")) {
            const after = Number(url.searchParams.get("afterSeq") || 0);
            return answer(session.events.filter((event) => event.seq > after));
        }
        if (action === "/steer") {
            const body = request.postDataJSON();
            state.steers.push({ ...body.options, sessionId });
            return handlers.steer ? handlers.steer({ route, body: body.options, answer, fail, state }) : answer({ outcome: "accepted", steerId: 900 + state.steers.length, turn: 3 });
        }
        if (action === "/stop-turn") {
            const body = request.postDataJSON();
            state.stops.push({ ...body.options, sessionId });
            return handlers.stop ? handlers.stop({ route, body: body.options, answer, fail, state }) : answer({ outcome: "stopped", turnIndex: 3, controlSeq: 950 });
        }
        if (action === "/messages") {
            const body = request.postDataJSON();
            state.sends.push({ ...body, sessionId });
            return handlers.send ? handlers.send({ route, body, answer, fail, state }) : answer({ queued: true });
        }
        return route.fallback();
    });
    let liveSeq = 1_000_000;
    const portal = {
        state,
        /** Change the viewer's sessions.steering decision; clients see it at their next read. */
        setSteering(value) { steering = value; },
        liveSubscriptions: (sessionId) => liveSubscriptions.get(sessionId) || 0,
        /** Push a durable session event to every socket subscribed to the session (seq above the REST window). */
        event(sessionId, eventType, data) {
            const event = { sessionId, seq: ++liveSeq, eventType, createdAt: Date.now(), data };
            state.sessions[sessionId].events.push(event);
            for (const [socket, subscribed] of sockets) {
                if (subscribed.has(sessionId)) socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event }));
            }
            return event.seq;
        },
        /**
         * The turn-control selectors of one session. The composer is looked up
         * inside `composerScope` and the transcript inside `transcriptScope`.
         */
        wire(sessionId, { composerScope = page, transcriptScope = page } = {}) {
            const composer = composerScope.locator(`.ps-prompt-shell[data-session-id="${sessionId}"]`);
            return {
                state, composer, sessionId,
                transcript: transcriptScope.locator(`.ps-scroll-panel[data-session-id="${sessionId}"]`),
                input: composer.getByTestId("composer-input"),
                steerButton: composer.getByTestId("turn-steer-button"),
                stopButton: composer.getByTestId("turn-stop-button"),
                sendButton: composer.locator(".ps-send-button"),
                turnState: composer.getByTestId("session-turn-state"),
                notice: composer.getByTestId("control-notice"),
                event: (eventType, data) => portal.event(sessionId, eventType, data),
                /** Change the detailed view; the event makes the portal re-read it. */
                async setDetail(fields) {
                    const { detail } = state.sessions[sessionId];
                    Object.assign(detail, fields, { statusVersion: detail.statusVersion + 1 });
                    this.event("assistant.usage", {});
                },
            };
        },
    };
    return portal;
}

/** The single-session view of SID. */
async function open(page, { detail = {}, events = [], ...options } = {}) {
    const portal = await fakePortal(page, { ...options, sessions: { [SID]: { title: "Turn control", detail, events } } });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SID}`);
    await expect.poll(() => portal.liveSubscriptions(SID)).toBeGreaterThan(0);
    return portal.wire(SID);
}

test("Steer is hidden with the flag off; Stop is not gated", async ({ page }) => {
    const off = await open(page, { steering: false });
    await expect(off.turnState).toHaveAttribute("data-accepts-controls", "true");
    await expect(off.stopButton).toHaveAttribute("data-state", "ready");
    await expect(off.steerButton).toHaveCount(0);
});

test("Steer is offered with the flag on while the turn accepts controls", async ({ page }) => {
    const on = await open(page, { steering: true });
    await expect(on.input).toBeVisible();
    await expect(on.steerButton).toHaveAttribute("data-state", "disabled");
    await on.input.fill("use metric units");
    await expect(on.steerButton).toHaveAttribute("data-state", "ready");
    await on.setDetail({ acceptsTurnControl: false, turnHigh: -1 });
    await expect(on.turnState).toHaveAttribute("data-accepts-controls", "false");
    await expect(on.steerButton).toHaveCount(0);
});

test("a read-only collaborator gets no composer and no Steer", async ({ page }) => {
    const wire = await open(page, { canWrite: false });
    await expect(page.locator(".ps-composer-readonly")).toBeVisible();
    await expect(page.getByTestId("turn-steer-button")).toHaveCount(0);
    await expect(wire.input).toHaveCount(0);
});

test("the turn state indicator passes every product status through", async ({ page }) => {
    const wire = await open(page);
    await expect(wire.turnState).toHaveAttribute("data-turn-state", "running");
    await expect(wire.turnState).toHaveAccessibleName("Running · accepts Stop and Steer");
    // No visible pixels: screen readers and tests read it.
    const box = await wire.turnState.boundingBox();
    expect(box.width * box.height).toBeLessThanOrEqual(1);
    const labels = { pending: "Pending", idle: "Idle", waiting: "Waiting", input_required: "Waiting for input", error: "Error",
        failed: "Failed", completed: "Completed", cancelled: "Cancelled", running: "Running · accepts Stop and Steer" };
    for (const [status, label] of Object.entries(labels)) {
        await wire.setDetail({ status, acceptsTurnControl: status === "running" });
        await expect(wire.turnState).toHaveAttribute("data-turn-state", status);
        await expect(wire.turnState).toHaveAccessibleName(label);
        await expect(wire.turnState).toHaveAttribute("data-accepts-controls", status === "running" ? "true" : "false");
    }
});

test("an accepted steer: sending, then the transcript item with each outcome", async ({ page }) => {
    let release;
    const wire = await open(page, { handlers: { steer: async ({ answer }) => { await new Promise((resolve) => { release = resolve; }); return answer({ outcome: "accepted", steerId: 901, turn: 3 }); } } });
    await wire.input.fill("prefer the shorter answer");
    await wire.steerButton.click();
    await expect(wire.steerButton).toHaveAttribute("data-state", "sending");
    await expect(wire.stopButton).toBeVisible();
    expect(wire.state.steers[0].text).toBe("prefer the shorter answer");
    expect(wire.state.steers[0].requestId).toBeTruthy();
    release();
    await expect(wire.input).toHaveValue("");
    await expect(wire.notice).toHaveCount(0);

    const seqs = {};
    for (const name of ["delivered", "carried", "carried_ran", "carried_then_stopped", "carried_not_run", "not_delivered", "pending"]) {
        seqs[name] = wire.event("user.steer", { turn: 3, text: `steer ${name}`, requestId: `r-${name}`, actor: null });
    }
    const steerItem = (name) => wire.transcript.locator(`[data-testid="control-steer"][data-control-seq="${seqs[name]}"]`);
    await expect(steerItem("delivered")).toHaveAttribute("data-outcome", "pending");
    await expect(steerItem("delivered").getByTestId("control-outcome-badge")).toHaveAttribute("data-outcome", "pending");
    const outcome = (name, value) => wire.event("session.control_outcome", { seq: seqs[name], turn: 3, outcome: value });
    outcome("delivered", "delivered");
    for (const name of ["carried", "carried_ran", "carried_then_stopped", "carried_not_run"]) outcome(name, "carried");
    outcome("not_delivered", "not_delivered");
    wire.event("session.carried_steers_closed", { seqs: [seqs.carried_ran], turnIndex: 4, reason: "ran" });
    wire.event("session.carried_steers_closed", { seqs: [seqs.carried_then_stopped], turnIndex: 4, reason: "stopped" });
    wire.event("session.carried_steers_closed", { seqs: [seqs.carried_not_run], turnIndex: 4, reason: "gave_up" });
    for (const name of Object.keys(seqs)) {
        await expect(steerItem(name)).toHaveCount(1);
        await expect(steerItem(name)).toHaveAttribute("data-outcome", name);
        await expect(steerItem(name).getByTestId("control-outcome-badge")).toHaveAttribute("data-outcome", name);
    }
    await expect(steerItem("carried")).toContainText("Will run next");
    await page.screenshot({ path: test.info().outputPath("turn-control-steer-outcomes.png") });

    // Reload: every item and badge unchanged, once.
    await page.reload();
    for (const name of Object.keys(seqs)) {
        await expect(steerItem(name)).toHaveCount(1);
        await expect(steerItem(name)).toHaveAttribute("data-outcome", name);
    }
});

test("Stop: stopping state, pending, stopped and too late, and the legacy line", async ({ page }) => {
    let release;
    const wire = await open(page, {
        events: [
            ev(1, "user.message", { content: "start", clientMessageIds: ["c-1"] }),
            ev(2, "session.turn_stopped", { turnIndex: 0, reason: "Stopped by user", interrupt: "stopped", clientMessageIds: ["c-1"] }),
            ev(3, "system.message", { content: "Turn stopped by user." }),
            ev(4, "session.turn_stopped", { turnIndex: 1, reason: "Stopped by user", interrupt: "stop_forced" }),
        ],
        handlers: { stop: async ({ answer }) => { await new Promise((resolve) => { release = resolve; }); return answer({ outcome: "stopped", turnIndex: 3, controlSeq: 2_000_000 }); } },
    });
    const legacy = wire.transcript.getByTestId("control-stop-legacy");
    await expect(legacy).toHaveCount(2);
    await expect(legacy.nth(0)).toHaveAttribute("data-outcome", "stopped");
    await expect(legacy.nth(1)).toHaveAttribute("data-outcome", "stop_forced");

    await wire.stopButton.click();
    await expect(wire.stopButton).toHaveAttribute("data-state", "stopping");
    expect(wire.state.stops[0].requestId).toBeTruthy();
    const stopSeq = wire.event("user.stop", { turn: 3, text: "Stopped by user", requestId: wire.state.stops[0].requestId, actor: null });
    const stopItem = wire.transcript.locator(`[data-testid="control-stop"][data-control-seq="${stopSeq}"]`);
    await expect(stopItem).toHaveAttribute("data-outcome", "pending");
    wire.event("session.control_outcome", { seq: stopSeq, turn: 3, outcome: "stopped" });
    release();
    await expect(stopItem).toHaveAttribute("data-outcome", "stopped");
    await expect(stopItem.getByTestId("control-outcome-badge")).toHaveAttribute("data-outcome", "stopped");
    const lateSeq = wire.event("user.stop", { turn: 4, text: "Stopped by user", requestId: "r-late", actor: null });
    wire.event("session.control_outcome", { seq: lateSeq, turn: 4, outcome: "too_late" });
    await expect(wire.transcript.locator(`[data-testid="control-stop"][data-control-seq="${lateSeq}"]`)).toHaveAttribute("data-outcome", "too_late");
    // The 1.0.81 path writes no system message; the user.stop line is the record.
    await expect(wire.transcript.getByText("Turn stopped by user.")).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath("turn-control-stop.png") });
});

test("a parent agent's Steer and Stop name the parent agent and carry data-actor-kind", async ({ page }) => {
    const wire = await open(page);
    const actor = { kind: "agent", sessionId: "22222222-2222-3333-4444-555555555555", display: "Coordinator" };
    const steerSeq = wire.event("user.steer", { turn: 3, text: "use metric units", requestId: "parent-steer:p:1", actor });
    const stopSeq = wire.event("user.stop", { turn: 3, text: "Stopped by parent agent", requestId: "parent-stop:p:2", actor });
    const personSeq = wire.event("user.steer", { turn: 3, text: "a person's steer", requestId: "r-person", actor: null });
    wire.event("session.control_outcome", { seq: steerSeq, turn: 3, outcome: "delivered" });
    wire.event("session.control_outcome", { seq: stopSeq, turn: 3, outcome: "stopped" });
    const steerItem = wire.transcript.locator(`[data-testid="control-steer"][data-control-seq="${steerSeq}"]`);
    const stopItem = wire.transcript.locator(`[data-testid="control-stop"][data-control-seq="${stopSeq}"]`);
    const personItem = wire.transcript.locator(`[data-testid="control-steer"][data-control-seq="${personSeq}"]`);
    await expect(steerItem).toHaveAttribute("data-actor-kind", "agent");
    await expect(steerItem).toContainText("Coordinator");
    await expect(steerItem.getByTestId("control-outcome-badge")).toHaveAttribute("data-outcome", "delivered");
    await expect(stopItem).toHaveAttribute("data-actor-kind", "agent");
    await expect(stopItem).toContainText("Coordinator: Stop");
    await expect(stopItem).toContainText("Stopped by parent agent");
    await expect(personItem).toHaveAttribute("data-actor-kind", "user");
    await expect(personItem).toContainText("You");
    await page.screenshot({ path: test.info().outputPath("turn-control-parent-agent.png") });
});

test("a definite no_turn refusal falls back to exactly one ordinary message", async ({ page }) => {
    let releaseSend;
    const wire = await open(page, { handlers: {
        steer: ({ answer }) => answer({ outcome: "no_turn" }),
        send: async ({ answer }) => { await new Promise((resolve) => { releaseSend = resolve; }); return answer({ queued: true }); },
    } });
    await wire.input.fill("send me anyway");
    await wire.steerButton.click();
    await expect(wire.notice).toHaveAttribute("data-reason", "no_turn");
    await expect(wire.notice).toHaveAttribute("data-kind", "steer");
    await expect.poll(() => wire.state.sends.length).toBe(1);
    const ids = wire.state.sends[0].options.clientMessageIds;
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(wire.state.steers[0].requestId);
    releaseSend();
    await expect(wire.notice).toHaveAttribute("data-reason", "fallback_sent");
    wire.event("user.message", { content: "send me anyway", clientMessageIds: ids });
    const messages = wire.transcript.locator('[data-testid="transcript-user-message"]', { hasText: "send me anyway" });
    await expect(messages).toHaveCount(1);
    await expect(messages).toHaveAttribute("data-client-message-id", ids[0]);
    await expect(wire.transcript.getByTestId("control-steer")).toHaveCount(0);
    expect(wire.state.steers).toHaveLength(1);
});

test("legacy_turn also falls back; a failed fallback says so", async ({ page }) => {
    let releaseSend;
    const wire = await open(page, { handlers: {
        steer: ({ answer }) => answer({ outcome: "legacy_turn" }),
        send: async ({ fail }) => { await new Promise((resolve) => { releaseSend = resolve; }); return fail(403, "FORBIDDEN", "Forbidden"); },
    } });
    await wire.input.fill("fallback fails");
    await wire.steerButton.click();
    await expect(wire.notice).toHaveAttribute("data-reason", "legacy_turn");
    releaseSend();
    await expect(wire.notice).toHaveAttribute("data-reason", "fallback_failed");
});

test("a lost steer response shows unconfirmed; Retry reuses the request id and records one steer", async ({ page }) => {
    const wire = await open(page, { handlers: {
        steer: ({ route, answer, state }) => (state.steers.length === 1 ? route.abort("connectionreset") : answer({ outcome: "accepted", steerId: 990, turn: 3, repeat: true })),
    } });
    await wire.input.fill("only once");
    await wire.steerButton.click();
    await expect(wire.notice).toHaveAttribute("data-reason", "unconfirmed");
    const retry = wire.notice.getByTestId("control-retry-button");
    await expect(retry).toHaveAttribute("data-request-id", wire.state.steers[0].requestId);
    await retry.click();
    await expect(wire.notice).toHaveCount(0);
    expect(wire.state.steers).toHaveLength(2);
    expect(wire.state.steers[1].requestId).toBe(wire.state.steers[0].requestId);
    expect(wire.state.steers[1].text).toBe("only once");
    expect(wire.state.sends).toHaveLength(0);
    wire.event("user.steer", { turn: 3, text: "only once", requestId: wire.state.steers[0].requestId, actor: null });
    await expect(wire.transcript.getByTestId("control-steer")).toHaveCount(1);
});

test("every other steer answer shows its notice and keeps the draft", async ({ page }) => {
    const answers = [
        ["not_found", ({ answer }) => answer({ outcome: "not_found" })],
        ["too_many", ({ answer }) => answer({ outcome: "too_many" })],
        ["request_id_reused", ({ answer }) => answer({ outcome: "request_id_reused" })],
        ["forbidden", ({ fail }) => fail(403, "FORBIDDEN", "Forbidden")],
        ["too_long", ({ fail }) => fail(413, "PAYLOAD_TOO_LARGE", "request entity too large")],
        ["error", ({ fail }) => fail(400, "INVALID_REQUEST", "bad request")],
        // Last: it turns the viewer's Steer off.
        ["steering_disabled", ({ answer }) => answer({ outcome: "steering_disabled" })],
    ];
    let current = null;
    const wire = await open(page, { handlers: { steer: (args) => current(args) } });
    for (const [reason, handler] of answers) {
        current = handler;
        await wire.input.fill(`draft ${reason}`);
        await wire.steerButton.click();
        await expect(wire.notice).toHaveAttribute("data-reason", reason);
        await expect(wire.notice).toHaveAttribute("data-kind", "steer");
        await expect(wire.input).toHaveValue(`draft ${reason}`);
    }
    await expect(wire.steerButton).toHaveCount(0);
    expect(wire.state.sends).toHaveLength(0);
});

test("every Stop notice: no active turn, timeout, pending Stop, unconfirmed with Retry, forbidden, error", async ({ page }) => {
    let current = null;
    const wire = await open(page, { handlers: { stop: (args) => current(args) } });
    const press = async (handler, reason) => {
        current = handler;
        await wire.stopButton.click();
        await expect(wire.notice).toHaveAttribute("data-reason", reason);
        await expect(wire.notice).toHaveAttribute("data-kind", "stop");
    };
    await press(({ answer }) => answer({ outcome: "no_active_turn", detail: "no turn is running" }), "no_active_turn");
    await press(({ answer }) => answer({ outcome: "timeout", turnIndex: 3 }), "timeout");
    await press(({ answer }) => answer({ outcome: "timeout", turnIndex: 3, controlSeq: 3_000_000 }), "stop_pending");
    await press(({ fail }) => fail(403, "FORBIDDEN", "Forbidden"), "forbidden");
    await press(({ fail }) => fail(400, "INVALID_REQUEST", "bad"), "error");
    await press(({ route }) => route.abort("connectionreset"), "unconfirmed");
    const unconfirmedId = wire.state.stops.at(-1).requestId;
    await expect(wire.notice.getByTestId("control-retry-button")).toHaveAttribute("data-request-id", unconfirmedId);
    current = ({ answer }) => answer({ outcome: "stopped", turnIndex: 3, controlSeq: 3_000_001 });
    await wire.notice.getByTestId("control-retry-button").click();
    await expect(wire.notice).toHaveCount(0);
    expect(wire.state.stops.at(-1).requestId).toBe(unconfirmedId);
    expect(new Set(wire.state.stops.slice(0, 6).map((stop) => stop.requestId)).size).toBe(6);
});

test("a refusal after a new draft keeps the steer text until Restore, also across a Stop", async ({ page }) => {
    let release;
    const wire = await open(page, { handlers: { steer: async ({ answer }) => { await new Promise((resolve) => { release = resolve; }); return answer({ outcome: "too_many" }); } } });
    await wire.input.fill("guidance first");
    await wire.steerButton.click();
    await expect(wire.input).toHaveValue("");
    await wire.input.fill("a new draft");
    release();
    await expect(wire.notice).toHaveAttribute("data-reason", "too_many");
    await expect(wire.input).toHaveValue("a new draft");
    const kept = wire.composer.getByTestId("control-kept-text");
    await expect(kept).toContainText("guidance first");
    // Another Stop does not take the kept text away.
    await wire.stopButton.click();
    await expect.poll(() => wire.state.stops.length).toBe(1);
    await expect(kept).toContainText("guidance first");
    await kept.getByTestId("control-restore-button").click();
    await expect(wire.input).toHaveValue("a new draft\n\nguidance first");
    await expect(kept).toHaveCount(0);
});

test("an unconfirmed steer keeps its Retry after a Stop and after the turn ends", async ({ page }) => {
    const wire = await open(page, { handlers: {
        steer: ({ route, answer, state }) => (state.steers.length === 1 ? route.abort("connectionreset") : answer({ outcome: "accepted", steerId: 995, turn: 3, repeat: true })),
        stop: ({ answer }) => answer({ outcome: "stopped", turnIndex: 3, controlSeq: 4_000_000 }),
    } });
    await wire.input.fill("steer before stop");
    await wire.steerButton.click();
    const steerNotice = wire.composer.locator('[data-testid="control-notice"][data-kind="steer"]');
    await expect(steerNotice).toHaveAttribute("data-reason", "unconfirmed");
    await wire.stopButton.click();
    await expect.poll(() => wire.state.stops.length).toBe(1);
    await wire.setDetail({ status: "idle", acceptsTurnControl: false, activeTurnIndex: null });
    await expect(wire.steerButton).toHaveCount(0);
    await expect(steerNotice).toHaveAttribute("data-reason", "unconfirmed");
    await steerNotice.getByTestId("control-retry-button").click();
    await expect(steerNotice).toHaveCount(0);
    expect(wire.state.steers[1].requestId).toBe(wire.state.steers[0].requestId);
});


test("a fallback behind an ordinary send in flight reports its own send", async ({ page }) => {
    const held = [];
    const wire = await open(page, { handlers: {
        steer: ({ answer }) => answer({ outcome: "no_turn" }),
        send: async ({ answer, fail }) => {
            const gate = await new Promise((resolve) => { held.push(resolve); });
            return gate === "fail" ? fail(403, "FORBIDDEN", "Forbidden") : answer({ queued: true });
        },
    } });
    await wire.input.fill("an ordinary message");
    await wire.composer.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect.poll(() => held.length).toBe(1);
    await wire.input.fill("steer that falls back");
    await wire.steerButton.click();
    await expect(wire.notice).toHaveAttribute("data-reason", "no_turn");
    held[0]("ok");
    await expect.poll(() => held.length).toBe(2);
    expect(wire.state.sends[1].prompt).toBe("steer that falls back");
    await expect(wire.notice).toHaveAttribute("data-reason", "no_turn");
    held[1]("fail");
    await expect(wire.notice).toHaveAttribute("data-reason", "fallback_failed");
});

test("a lost Stop and a lost Steer each keep their own notice and Retry", async ({ page }) => {
    const wire = await open(page, { handlers: {
        stop: ({ route }) => route.abort("connectionreset"),
        steer: ({ route }) => route.abort("connectionreset"),
    } });
    await wire.stopButton.click();
    await wire.input.fill("both lost");
    await wire.steerButton.click();
    const stopNotice = wire.composer.locator('[data-testid="control-notice"][data-kind="stop"]');
    const steerNotice = wire.composer.locator('[data-testid="control-notice"][data-kind="steer"]');
    await expect(stopNotice).toHaveAttribute("data-reason", "unconfirmed");
    await expect(steerNotice).toHaveAttribute("data-reason", "unconfirmed");
    await expect(stopNotice.getByTestId("control-retry-button")).toHaveAttribute("data-request-id", wire.state.stops[0].requestId);
    await expect(steerNotice.getByTestId("control-retry-button")).toHaveAttribute("data-request-id", wire.state.steers[0].requestId);
    await wire.setDetail({ status: "idle", acceptsTurnControl: false, activeTurnIndex: null });
    await expect(wire.steerButton).toHaveCount(0);
    await steerNotice.getByRole("button", { name: "Dismiss" }).click();
    await expect(steerNotice).toHaveCount(0);
    await expect(wire.input).toHaveValue("both lost");
    await expect(stopNotice).toHaveAttribute("data-reason", "unconfirmed");
});

// Master of Agents and the phone focus views: the same composer, shared by
// several sessions, must send each control to the session it shows.

const TWO_SESSIONS = { [SID]: { title: "Agent A" }, [SID2]: { title: "Agent B" } };
const moaProfile = (themeId = "terminal-green") => ({ themeId, moa: { version: 2, aspectRatio: 2, composerMode: "shared",
    tree: { id: "split", type: "split", direction: "row", ratio: 50,
        first: { id: "pa", type: "chat", sessionId: SID }, second: { id: "pb", type: "chat", sessionId: SID2 } } } });
const moaPanel = (page, id) => page.locator(`[data-moa-panel="${id}"]`);
const moaWire = (page, portal, sessionId, panelId) => portal.wire(sessionId, {
    composerScope: page.locator(".ps-moa-composer-strip"), transcriptScope: moaPanel(page, panelId) });

async function openMoa(page, portal) {
    const before = portal.liveSubscriptions(SID);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SID}`);
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await expect(page.locator(".ps-moa-composer-strip")).toBeVisible();
    await expect.poll(() => portal.liveSubscriptions(SID)).toBeGreaterThan(before);
}

/** Each control is inside the viewport, is the element hit at its centre, and no two overlap. */
async function expectControlsFit(controls) {
    const boxes = [];
    for (const [name, locator] of Object.entries(controls)) {
        await expect(locator, name).toBeVisible();
        const box = await locator.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight,
                hit: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
        });
        expect(box.left, `${name} left edge`).toBeGreaterThanOrEqual(0);
        expect(box.top, `${name} top edge`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${name} right edge`).toBeLessThanOrEqual(box.width);
        expect(box.bottom, `${name} bottom edge`).toBeLessThanOrEqual(box.height);
        expect(box.hit, `${name} is not covered`).toBe(true);
        boxes.push([name, box]);
    }
    for (const [i, [a, ra]] of boxes.entries()) {
        for (const [b, rb] of boxes.slice(i + 1)) {
            const overlap = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left))
                * Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
            expect(overlap, `${a} and ${b} do not overlap`).toBeLessThanOrEqual(1);
        }
    }
}

/** The turn status has no visible pixels; its accessible name carries it. */
async function expectHiddenStatus(wire, label) {
    await expect(wire.turnState).toHaveAccessibleName(label);
    const box = await wire.turnState.boundingBox();
    expect(box.width * box.height, "no visible pixels").toBeLessThanOrEqual(1);
}

/**
 * The phone composer is one line: the input and every control share the
 * input's row, inside the viewport, touch-sized, with no "you" label.
 * Returns the input width.
 */
async function expectOneLinePhoneComposer(wire, { stop }) {
    const controls = { input: wire.input, ...(stop ? { stop: wire.stopButton } : {}), send: wire.sendButton };
    await expectControlsFit(controls);
    await expect(wire.composer.locator(".ps-prompt-label")).toBeHidden();
    await expect(wire.steerButton).toHaveCount(0);
    const input = await wire.input.boundingBox();
    for (const [name, locator] of Object.entries(controls)) {
        if (name === "input") continue;
        const box = await locator.boundingBox();
        expect(box.y + box.height / 2, `${name} is on the input's row`).toBeGreaterThan(input.y);
        expect(box.y + box.height / 2, `${name} is on the input's row`).toBeLessThan(input.y + input.height);
        expect(box.x, `${name} is right of the input`).toBeGreaterThanOrEqual(input.x + input.width);
        expect(Math.min(box.width, box.height), `${name}: a touch target of at least 40 px`).toBeGreaterThanOrEqual(40);
    }
    return input.width;
}

/** Steer `text` from `wire` (desktop: ↪; phones: a tap on the blue button), then Stop; both must name `sessionId`. */
async function steerAndStop(wire, sessionId, text, { phone = false } = {}) {
    const steers = wire.state.steers.length, stops = wire.state.stops.length;
    await wire.input.fill(text);
    if (phone) {
        await expect(wire.sendButton).toHaveAttribute("data-action", "steer");
        await wire.sendButton.click();
    } else {
        await wire.steerButton.click();
    }
    await expect.poll(() => wire.state.steers.length).toBe(steers + 1);
    expect(wire.state.steers.at(-1)).toMatchObject({ sessionId, text });
    expect(wire.state.steers.at(-1).replacesClientMessageId).toBeUndefined();
    await expect(wire.input).toHaveValue("");
    await wire.stopButton.click();
    await expect.poll(() => wire.state.stops.length).toBe(stops + 1);
    expect(wire.state.stops.at(-1).sessionId).toBe(sessionId);
}

test("MoA: the sole composer's Steer and Stop act on the focused panel's session only", async ({ page }) => {
    const portal = await fakePortal(page, { sessions: TWO_SESSIONS, profile: moaProfile() });
    await openMoa(page, portal);
    const a = moaWire(page, portal, SID, "pa"), b = moaWire(page, portal, SID2, "pb");
    await expect.poll(() => portal.liveSubscriptions(SID2)).toBeGreaterThan(0);
    /** The session's recorded Steer and Stop come back as transcript events, each with its outcome. */
    const echo = (wire, index, text) => {
        const steer = wire.event("user.steer", { turn: 3, text, requestId: portal.state.steers[index].requestId, actor: null });
        wire.event("session.control_outcome", { seq: steer, turn: 3, outcome: "delivered" });
        const stop = wire.event("user.stop", { turn: 3, text: "Stopped by user", requestId: portal.state.stops[index].requestId, actor: null });
        wire.event("session.control_outcome", { seq: stop, turn: 3, outcome: "stopped" });
        return { steer, stop };
    };
    /** Exactly the session's own steer and stop item render in its panel, with their badges. */
    const expectItems = async (panelId, seqs) => {
        for (const [kind, outcome] of [["steer", "delivered"], ["stop", "stopped"]]) {
            const items = moaPanel(page, panelId).getByTestId(`control-${kind}`);
            await expect(items).toHaveCount(seqs ? 1 : 0);
            if (seqs) {
                await expect(items).toHaveAttribute("data-control-seq", String(seqs[kind]));
                await expect(items.getByTestId("control-outcome-badge")).toHaveAttribute("data-outcome", outcome);
            }
        }
    };

    await moaPanel(page, "pa").locator("header").first().click();
    await expect(a.turnState).toHaveAttribute("data-accepts-controls", "true");
    await expect(b.composer).toHaveCount(0);
    await steerAndStop(a, SID, "steer for agent A");
    const seqsA = echo(a, 0, "steer for agent A");
    await expectItems("pa", seqsA);
    await expectItems("pb", null);
    await a.input.fill("draft kept in A");

    // Focus moves the composer, its Steer and its Stop to the other session.
    await moaPanel(page, "pb").locator("header").first().click();
    await expect(moaPanel(page, "pb")).toHaveClass(/is-focused/);
    await expect(a.composer).toHaveCount(0);
    await expect(b.input).toHaveValue("");
    await steerAndStop(b, SID2, "steer for agent B");
    const seqsB = echo(b, 1, "steer for agent B");
    await expectItems("pb", seqsB);
    await expectItems("pa", seqsA);

    await moaPanel(page, "pa").locator("header").first().click();
    await expect(a.input).toHaveValue("draft kept in A");
    expect(portal.state.steers.map((steer) => steer.sessionId)).toEqual([SID, SID2]);
    expect(portal.state.stops.map((stop) => stop.sessionId)).toEqual([SID, SID2]);
    expect(portal.state.sends).toEqual([]);
});

// ── The composer: Steer and the queue (owner design, 2026-10-14) ──────────
// Desktop: ↪ steers the typed text, a selected queued message (↑ or a click
// on its line), or with an empty box every queued message (↪ N); ✕ deletes a
// selected queued message. Phones: one line, the blue button steers on a tap
// and offers Queue on a hold. A message read by the model leaves the strip.
// Screenshots go to the test output and, when PS_UX_SHOTS_DIR is set, to that
// folder (the UX report).

const THEMES = [{ name: "default", profile: null }, { name: "terminal-green", profile: { themeId: "terminal-green" } }];
const QUEUED_TEXT = "and let me know what the agent is doing in this space";
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 740 }];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function shot(page, name) {
    const file = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path: file });
    const dir = process.env.PS_UX_SHOTS_DIR;
    if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(file, path.join(dir, `${name}.png`));
    }
}

/** The queued-prompts strip of the wire's session (in its chat panel), with its lines. */
const queuedRows = (wire) => {
    const strip = wire.composer.page().locator(`[data-testid="queued-actions"][data-session-id="${wire.sessionId}"]`);
    return { strip, item: strip.getByTestId("queued-item"), notice: strip.getByTestId("queued-notice") };
};

/** Queue `text` while the turn runs (phones: the hold menu's Queue when the blue button steers). Returns its client message id. */
async function queueMessage(wire, text = QUEUED_TEXT) {
    const before = await queuedRows(wire).item.count();
    await wire.input.fill(text);
    if (await wire.sendButton.getAttribute("data-action") === "steer") await holdAndPick(wire, "queue");
    else await wire.sendButton.click();
    const line = queuedRows(wire).item.filter({ hasText: text });
    await expect(line).toHaveAttribute("data-phase", "queued");
    await expect(queuedRows(wire).item).toHaveCount(before + 1);
    return line.getAttribute("data-item-id");
}

/** Queue a message with an image: its line, and its client message id. */
async function queueImageMessage(page, wire, text) {
    await page.route("**/api/v1/sessions/*/artifacts/*", (route) => route.fulfill({
        json: { ok: true, result: { filename: decodeURIComponent(route.request().url().split("/").pop()), sizeBytes: 3 } } }));
    await wire.input.fill(text);
    await wire.composer.locator('input[type="file"]').setInputFiles([{ name: "chart.png", mimeType: "image/png", buffer: PNG }]);
    await expect(wire.sendButton).toHaveAttribute("data-action", "send");
    await wire.sendButton.click();
    const line = queuedRows(wire).item.filter({ hasText: text });
    await expect(line).toHaveAttribute("data-phase", "queued");
    return line.getAttribute("data-item-id");
}

/** A steer route that records the steer as the server does, once the test releases it. */
function heldSteer(wire) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return {
        release: () => release(),
        handler: async ({ answer, body }) => {
            await gate;
            const steerId = wire.event("user.steer", { turn: 3, text: body.text, requestId: body.requestId, actor: null,
                ...(body.replacesClientMessageId ? { replacesClientMessageId: body.replacesClientMessageId } : {}) });
            return answer({ outcome: "accepted", steerId, turn: 3 });
        },
    };
}

/** The steer the server recorded for `requestId` (its transcript seq). */
const steerSeqOf = (wire, requestId) => wire.state.sessions[wire.sessionId].events
    .find((event) => event.eventType === "user.steer" && event.data.requestId === requestId)?.seq;

/** Press and hold the phone's blue button until its menu opens; returns the menu. */
async function holdOpen(wire) {
    const page = wire.composer.page();
    const box = await wire.sendButton.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const menu = wire.composer.getByTestId("steer-hold-menu");
    await expect(menu).toBeVisible();
    return menu;
}

/** Hold the blue button, slide onto `item` ("steer" or "queue") and release there. */
async function holdAndPick(wire, item) {
    const page = wire.composer.page();
    const menu = await holdOpen(wire);
    const target = await menu.getByTestId(`steer-hold-${item}`).boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
    await expect(menu.getByTestId(`steer-hold-${item}`)).toHaveClass(/is-lit/);
    await page.mouse.up();
    await expect(menu).toHaveCount(0);
}

/** A phone view of SID: the plain chat, Zen, or the focused MoA panel. */
async function openPhoneView(page, view, { viewport, ...options } = {}) {
    await page.setViewportSize(viewport);
    const portal = await fakePortal(page, { sessions: TWO_SESSIONS, ...options, profile: view === "moa" ? moaProfile(options.profile?.themeId) : options.profile || null });
    if (view === "moa") {
        await openMoa(page, portal);
        await expect(moaPanel(page, "pa")).toHaveClass(/is-focused/);
        return { portal, wire: moaWire(page, portal, SID, "pa") };
    }
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SID}`);
    await expect.poll(() => portal.liveSubscriptions(SID)).toBeGreaterThan(0);
    if (view === "zen") await page.getByRole("button", { name: "Enter mobile zen", exact: true }).click();
    return { portal, wire: portal.wire(SID, { composerScope: page.locator(view === "zen" ? ".ps-mobile-zen-composer" : ".ps-chat-composer") }) };
}

for (const theme of THEMES) {
    test(`desktop (${theme.name}): typed text steers; the empty box steers both queued messages (↪ 2), each leaves the strip once read`, async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 950 });
        let held;
        const wire = await open(page, { profile: theme.profile, handlers: { steer: (args) => held.handler(args) } });
        held = heldSteer(wire);
        held.release();
        await expectHiddenStatus(wire, "Running · accepts Stop and Steer");
        await expect(wire.steerButton.locator(".ps-steer-arrow")).toHaveCSS("font-size", "22px");
        await wire.input.fill("compare with ClickHouse instead");
        await expect(wire.steerButton).toHaveAttribute("data-steer-target", "text");
        await expect(wire.steerButton).toHaveAttribute("title", "Steer this text into the running turn now (Ctrl+T)");
        await shot(page, `composer-desktop-typed-${theme.name}`);
        await wire.steerButton.click();
        await expect.poll(() => wire.state.steers.length).toBe(1);
        expect(wire.state.steers[0]).toMatchObject({ text: "compare with ClickHouse instead" });

        const first = await queueMessage(wire, "also cover MotherDuck");
        const second = await queueMessage(wire, "keep it under one page");
        await expect(wire.steerButton).toHaveAttribute("data-steer-target", "queue");
        await expect(wire.steerButton).toHaveAttribute("data-count", "2");
        await expect(wire.steerButton).toHaveText("↪2");
        await expect(wire.steerButton).toHaveAttribute("title", "Steer your 2 queued messages now");
        await shot(page, `composer-desktop-empty-two-queued-${theme.name}`);
        await wire.steerButton.click();
        await expect.poll(() => wire.state.steers.length).toBe(3);
        expect(wire.state.steers.slice(1).map((steer) => [steer.text, steer.replacesClientMessageId]))
            .toEqual([["also cover MotherDuck", first], ["keep it under one page", second]]);
        const rows = queuedRows(wire);
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toHaveAttribute("data-phase", "steering");
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toContainText("↪");
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toContainText("steering");
        await expect(rows.strip).toContainText("queued prompts: 2 steering");
        await shot(page, `composer-desktop-steering-${theme.name}`);

        // The model reads the first steer: its line leaves the strip; the transcript says Delivered.
        await expect.poll(() => steerSeqOf(wire, wire.state.steers[1].requestId)).toBeTruthy();
        const seq = steerSeqOf(wire, wire.state.steers[1].requestId);
        wire.event("session.steer_confirmed", { seq, turn: 3, messageId: "m-1" });
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toHaveCount(0);
        await expect(wire.transcript.locator(`[data-testid="control-steer"][data-control-seq="${seq}"]`)).toHaveAttribute("data-outcome", "delivered");
        await expect(rows.item).toHaveCount(1);
        await shot(page, `composer-desktop-delivered-${theme.name}`);
        // The turn is then stopped: the read steer is discarded (D10) and the message is queued again, once.
        wire.event("session.control_outcome", { seq, turn: 3, outcome: "not_delivered" });
        const back = rows.item.filter({ hasText: "also cover MotherDuck" });
        await expect(back).toHaveAttribute("data-phase", "queued");
        await expect(back.getByTestId("queued-notice")).toHaveText("The turn was stopped, so the steer was discarded. Still queued; it runs next.");
        await shot(page, `composer-desktop-stopped-after-read-${theme.name}`);
        expect(wire.state.sends).toHaveLength(2);
    });

    test(`desktop (${theme.name}): a selected queued message (a click on its line, or ↑): ↪ steers only it, ✕ deletes it; Esc leaves`, async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 950 });
        const wire = await open(page, { profile: theme.profile });
        await page.route("**/api/v1/sessions/*/cancel-pending", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: {} }) }));
        const first = await queueMessage(wire, "also cover MotherDuck");
        const second = await queueMessage(wire, "keep it under one page");
        const rows = queuedRows(wire);
        await rows.item.filter({ hasText: "keep it under one page" }).click();
        await expect(rows.item.filter({ hasText: "keep it under one page" })).toHaveAttribute("data-selected", "true");
        await expect(wire.input).toHaveValue("keep it under one page");
        await expect(wire.input).toHaveAttribute("readonly", "");
        const del = wire.composer.getByTestId("queued-delete");
        await expect(del).toHaveText("✕");
        await expect(del).toHaveAttribute("title", "Delete this queued message (Esc to leave)");
        await expect(wire.steerButton).toHaveAttribute("data-steer-target", "selected");
        await shot(page, `composer-desktop-selected-${theme.name}`);
        await wire.input.press("Escape");
        await expect(wire.input).toHaveValue("");
        await expect(del).toHaveCount(0);
        await expect(wire.steerButton).toHaveAttribute("data-steer-target", "queue");

        await wire.input.press("ArrowUp");
        await expect(rows.item.filter({ hasText: "keep it under one page" })).toHaveAttribute("data-selected", "true");
        await wire.steerButton.click();
        await expect.poll(() => wire.state.steers.length).toBe(1);
        expect(wire.state.steers[0]).toMatchObject({ text: "keep it under one page", replacesClientMessageId: second });
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toHaveAttribute("data-phase", "queued");

        await rows.item.filter({ hasText: "also cover MotherDuck" }).click();
        await wire.composer.getByTestId("queued-delete").click();
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toHaveAttribute("data-phase", "cancelling");
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toContainText("Cancelling · takes effect when the turn ends");
        await shot(page, `composer-desktop-cancelling-${theme.name}`);
        wire.event("pending_messages.cancelled", { clientMessageIds: [first], reason: "drain-incoming" });
        await expect(rows.item.filter({ hasText: "also cover MotherDuck" })).toHaveCount(0);
        expect(wire.state.steers).toHaveLength(1);
    });

    test(`desktop (${theme.name}): a queued image disables ↪ on the queue and on that message; the reason is the tooltip`, async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 950 });
        const wire = await open(page, { profile: theme.profile });
        await queueMessage(wire, "also cover MotherDuck");
        await queueImageMessage(page, wire, "and this chart");
        await expect(wire.steerButton).toHaveAttribute("data-steer-target", "queue");
        await expect(wire.steerButton).toBeDisabled();
        await expect(wire.steerButton).toHaveAttribute("title", "A queued message has an image; images cannot be steered");
        await shot(page, `composer-desktop-image-disabled-${theme.name}`);
        await queuedRows(wire).item.filter({ hasText: "and this chart" }).click();
        await expect(wire.steerButton).toBeDisabled();
        await expect(wire.steerButton).toHaveAttribute("title", "This message has an image; images cannot be steered");
        await queuedRows(wire).item.filter({ hasText: "also cover MotherDuck" }).click();
        await expect(wire.steerButton).toBeEnabled();
        expect(wire.state.steers).toEqual([]);
    });

    test(`desktop (${theme.name}): a steer that misses brings the line back queued with one notice; the transcript says still queued`, async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 950 });
        let held;
        const wire = await open(page, { profile: theme.profile, handlers: { steer: (args) => held.handler(args) } });
        held = heldSteer(wire);
        held.release();
        await queueMessage(wire);
        await wire.steerButton.click();
        await expect.poll(() => wire.state.steers.length).toBe(1);
        await expect.poll(() => steerSeqOf(wire, wire.state.steers[0].requestId)).toBeTruthy();
        const steerSeq = steerSeqOf(wire, wire.state.steers[0].requestId);
        wire.event("session.control_outcome", { seq: steerSeq, turn: 3, outcome: "not_delivered" });
        const rows = queuedRows(wire);
        await expect(rows.item).toHaveAttribute("data-phase", "queued");
        await expect(rows.notice).toHaveText("Could not steer: the turn ended before the agent read it. Still queued.");
        const steerItem = wire.transcript.locator(`[data-testid="control-steer"][data-control-seq="${steerSeq}"]`);
        await expect(steerItem).toHaveAttribute("data-outcome", "not_delivered_still_queued");
        await shot(page, `composer-desktop-not-delivered-${theme.name}`);
        expect(wire.state.sends).toHaveLength(1);
    });

    test(`MoA (${theme.name}): the focused panel's queue and ↪ belong to its session`, async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 950 });
        const portal = await fakePortal(page, { sessions: TWO_SESSIONS, profile: moaProfile(theme.profile?.themeId || "workspace-dark") });
        await openMoa(page, portal);
        const a = moaWire(page, portal, SID, "pa"), b = moaWire(page, portal, SID2, "pb");
        await expect.poll(() => portal.liveSubscriptions(SID2)).toBeGreaterThan(0);
        await moaPanel(page, "pb").locator("header").first().click();
        await expect(moaPanel(page, "pb")).toHaveClass(/is-focused/);
        const id = await queueMessage(b, "queued for agent B");
        await expect(b.steerButton).toHaveAttribute("data-count", "1");
        await shot(page, `composer-moa-${theme.name}`);
        await b.steerButton.click();
        await expect.poll(() => portal.state.steers.length).toBe(1);
        expect(portal.state.steers[0]).toMatchObject({ sessionId: SID2, replacesClientMessageId: id });
        await moaPanel(page, "pa").locator("header").first().click();
        await expect(moaPanel(page, "pa")).toHaveClass(/is-focused/);
        await expect(queuedRows(a).item).toHaveCount(0);
        await expect(a.steerButton).toHaveAttribute("data-steer-target", "none");
    });
}

// QC-10: the steering decision is per viewer. Opened without a deep link,
// the portal restores the active session from the profile; its Steer must be
// offered without visiting another session first.
test("opened without a deep link: the profile's restored running session offers Steer on text and on the queue", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 950 });
    const portal = await fakePortal(page, { sessions: { [SID]: { title: "Restored" } }, profile: { activeSessionId: SID } });
    await page.goto(`http://127.0.0.1:${stub.port}/`);
    await expect.poll(() => portal.liveSubscriptions(SID)).toBeGreaterThan(0);
    const wire = portal.wire(SID);
    await expect(wire.turnState).toHaveAttribute("data-accepts-controls", "true");
    await wire.input.fill("guidance for the restored turn");
    await expect(wire.steerButton).toHaveAttribute("data-state", "ready");
    await wire.input.fill("");
    await queueMessage(wire);
    await expect(wire.steerButton).toHaveAttribute("data-steer-target", "queue");
    await expect(wire.steerButton).toHaveAttribute("data-state", "ready");
});

test("MoA: a panel picks up the viewer's steering decision while it stays open", async ({ page }) => {
    await page.clock.install();
    const portal = await fakePortal(page, { sessions: TWO_SESSIONS, steering: false, profile: moaProfile() });
    await openMoa(page, portal);
    const a = moaWire(page, portal, SID, "pa");
    await moaPanel(page, "pa").locator("header").first().click();
    await expect(a.turnState).toHaveAttribute("data-accepts-controls", "true");
    await expect(a.steerButton).toHaveCount(0);
    portal.setSteering(true);
    await page.clock.fastForward(35_000);
    await expect(a.steerButton).toHaveCount(1);
});

test("narrow desktop 700x800: Stop, ↪ and Send fit beside the input; no visible status", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const wire = await open(page);
    await expectHiddenStatus(wire, "Running · accepts Stop and Steer");
    await wire.input.fill("x");
    await expectControlsFit({ input: wire.input, stop: wire.stopButton, steer: wire.steerButton, send: wire.sendButton });
    await shot(page, "composer-desktop-700");
});

// ── Phones: one line; the blue button steers ──────────────────────────────

for (const viewport of PHONES) {
    for (const view of ["chat", "zen", "moa"]) {
        test(`phone ${view} ${viewport.width}x${viewport.height}: one line idle and running, no layout jump; a tap steers; Stop`, async ({ page }) => {
            const { portal, wire } = await openPhoneView(page, view, { viewport });
            await wire.setDetail({ status: "idle", acceptsTurnControl: false, activeTurnIndex: null });
            await expectHiddenStatus(wire, "Idle");
            await expect(wire.sendButton).toHaveAttribute("data-action", "send");
            const idleWidth = await expectOneLinePhoneComposer(wire, { stop: false });
            const idleHeight = (await wire.composer.boundingBox()).height;
            if (view === "chat") await shot(page, `composer-phone-${viewport.width}-idle`);
            await wire.setDetail({ status: "running", acceptsTurnControl: true, activeTurnIndex: 3 });
            await expectHiddenStatus(wire, "Running · accepts Stop and Steer");
            await expect(wire.sendButton).toHaveAttribute("data-action", "steer");
            const runningWidth = await expectOneLinePhoneComposer(wire, { stop: true });
            expect(Math.abs((await wire.composer.boundingBox()).height - idleHeight), "the composer does not grow when a turn starts").toBeLessThan(1);
            test.info().annotations.push({ type: "input width", description: `${view} ${viewport.width}: idle ${Math.round(idleWidth)} px, running ${Math.round(runningWidth)} px` });
            await wire.input.fill("compare with ClickHouse");
            await expect(wire.sendButton).toHaveClass(/can-hold/);
            await expect(wire.sendButton).toHaveAccessibleName("Steer now, hold for Queue");
            await expect(wire.sendButton).toHaveAttribute("aria-haspopup", "menu");
            if (view === "chat") await shot(page, `composer-phone-${viewport.width}-running-steerable`);
            await steerAndStop(wire, SID, "compare with ClickHouse", { phone: true });
            expect(portal.state.sends).toEqual([]);
        });
    }

    for (const count of [0, 1, 2, 5]) {
        test(`phone chat ${viewport.width}x${viewport.height}, ${count} queued: each message once; every control on the input's row and on screen`, async ({ page }) => {
            const { wire } = await openPhoneView(page, "chat", { viewport });
            const texts = Array.from({ length: count }, (_, i) => `queued message number ${i + 1} with enough words to wrap on a phone`);
            for (const text of texts) await queueMessage(wire, text);
            for (const text of texts) await expect(page.getByText(text)).toHaveCount(1);
            await expect(queuedRows(wire).item.filter({ has: page.locator(".ps-queued-item-phase") })).toHaveCount(0);
            await expectOneLinePhoneComposer(wire, { stop: true });
            await wire.input.fill("x");
            await expectOneLinePhoneComposer(wire, { stop: true });
            if (count) {
                const visibleBottom = await queuedRows(wire).strip.evaluate((el) => el.closest(".ps-panel-bottom-sticky, .ps-scroll-panel").getBoundingClientRect().bottom);
                expect(visibleBottom).toBeLessThanOrEqual((await wire.composer.boundingBox()).y + 2);
            }
        });
    }

    for (const view of ["zen", "moa"]) {
        test(`phone ${view} ${viewport.width}x${viewport.height}, 5 queued: every control on the input's row and on screen`, async ({ page }) => {
            const { wire } = await openPhoneView(page, view, { viewport });
            for (let i = 1; i <= 5; i += 1) await queueMessage(wire, `queued message number ${i} with enough words to wrap on a phone`);
            await expectOneLinePhoneComposer(wire, { stop: true });
        });
    }

    test(`phone chat ${viewport.width}x${viewport.height}: the empty box steers both queued messages (↪ 2); no per-message selection or ✕`, async ({ page }) => {
        const { wire } = await openPhoneView(page, "chat", { viewport });
        const first = await queueMessage(wire, "also cover MotherDuck");
        const second = await queueMessage(wire, "keep it short");
        await expect(wire.sendButton).toHaveAttribute("data-steer-target", "queue");
        await expect(wire.sendButton).toHaveAttribute("data-count", "2");
        await expect(wire.sendButton).toHaveText("↪2");
        await expect(wire.sendButton).not.toHaveClass(/can-hold/);
        await expect(queuedRows(wire).item.first()).not.toHaveAttribute("role", "button");
        await queuedRows(wire).item.first().click();
        await expect(wire.input).toHaveValue("");
        await expect(wire.composer.getByTestId("queued-delete")).toHaveCount(0);
        await shot(page, `composer-phone-${viewport.width}-empty-two-queued`);
        await wire.sendButton.click();
        await expect.poll(() => wire.state.steers.length).toBe(2);
        expect(wire.state.steers.map((steer) => [steer.text, steer.replacesClientMessageId])).toEqual([["also cover MotherDuck", first], ["keep it short", second]]);
    });

    test(`phone chat ${viewport.width}x${viewport.height}: not steerable (steering off) the blue button is the plain +, no hold menu`, async ({ page }) => {
        const { wire } = await openPhoneView(page, "chat", { viewport, steering: false });
        await wire.input.fill("queue this one");
        await expect(wire.sendButton).toHaveAttribute("data-action", "send");
        await expect(wire.sendButton).not.toHaveAttribute("aria-haspopup", "menu");
        await expectOneLinePhoneComposer(wire, { stop: true });
        if (viewport.width === 390) await shot(page, "composer-phone-390-not-steerable");
        await wire.sendButton.click();
        await expect.poll(() => wire.state.sends.length).toBe(1);
        expect(wire.state.steers).toEqual([]);
    });

    test(`phone chat ${viewport.width}x${viewport.height}: a queued image disables the blue button's steer of the queue`, async ({ page }) => {
        const { wire } = await openPhoneView(page, "chat", { viewport });
        await queueMessage(wire, "also cover MotherDuck");
        await queueImageMessage(page, wire, "and this chart");
        await expect(wire.sendButton).toHaveAttribute("data-action", "steer");
        await expect(wire.sendButton).toBeDisabled();
        await expect(wire.sendButton).toHaveAttribute("title", "A queued message has an image; images cannot be steered");
        if (viewport.width === 390) await shot(page, "composer-phone-390-image-disabled");
        expect(wire.state.steers).toEqual([]);
    });
}

test("phone 390x844 (terminal-green): running steerable, the hold menu, and the empty box with ↪ 2", async ({ page }) => {
    const { wire } = await openPhoneView(page, "chat", { viewport: PHONES[0], profile: { themeId: "terminal-green" } });
    await wire.input.fill("compare with ClickHouse");
    await expect(wire.sendButton).toHaveClass(/can-hold/);
    await shot(page, "composer-phone-390-running-steerable-terminal-green");
    await holdOpen(wire);
    await shot(page, "composer-phone-390-hold-menu-terminal-green");
    await page.mouse.move(10, 10, { steps: 3 });
    await page.mouse.up();
    await expect(wire.composer.getByTestId("steer-hold-menu")).toHaveCount(0);
    await wire.input.fill("");
    await queueMessage(wire, "also cover MotherDuck");
    await queueMessage(wire, "keep it short");
    await expect(wire.sendButton).toHaveText("↪2");
    await shot(page, "composer-phone-390-empty-two-queued-terminal-green");
});

test("phone 390x844, keyboard: Enter steers; ArrowUp opens the menu on Steer now, ArrowDown moves to Queue, Enter queues; focus returns to the input", async ({ page }) => {
    const { wire } = await openPhoneView(page, "chat", { viewport: PHONES[0] });
    await wire.input.fill("prefer the shorter answer");
    await wire.sendButton.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => wire.state.steers.length).toBe(1);
    expect(wire.state.steers[0]).toMatchObject({ text: "prefer the shorter answer" });
    await wire.input.fill("queue this from the keyboard");
    await expect(wire.sendButton).toHaveAttribute("data-state", "ready");
    await wire.sendButton.focus();
    await page.keyboard.press("ArrowUp");
    const menu = wire.composer.getByTestId("steer-hold-menu");
    await expect(menu.getByTestId("steer-hold-steer")).toBeFocused();
    await expect(menu.getByTestId("steer-hold-steer")).toHaveClass(/is-lit/);
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("steer-hold-queue")).toBeFocused();
    await expect(menu.getByTestId("steer-hold-queue")).toHaveClass(/is-lit/);
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(queuedRows(wire).item.filter({ hasText: "queue this from the keyboard" })).toHaveAttribute("data-phase", "queued");
    await expect(wire.input).toBeFocused();
    await wire.input.fill("escape keeps the text");
    await expect(wire.sendButton).toHaveAttribute("data-action", "steer");
    await expect(wire.sendButton).toHaveAttribute("data-state", "ready");
    await wire.sendButton.focus();
    await page.keyboard.press("ArrowUp");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(wire.input).toBeFocused();
    await expect(wire.input).toHaveValue("escape keeps the text");
    expect(wire.state.steers).toHaveLength(1);
});

// Enter is decided by the input, not the width: with a physical keyboard
// (a fine pointer) Enter sends and Shift+Enter adds a line at every width;
// a touch keyboard's return key adds a line and the button sends.
test("narrow desktop 700x800 with a keyboard: Shift+Enter adds a line, Enter sends", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const wire = await open(page, { detail: { status: "idle", acceptsTurnControl: false, activeTurnIndex: null } });
    await wire.input.fill("first line");
    await wire.input.press("Shift+Enter");
    await wire.input.pressSequentially("second line");
    await expect(wire.input).toHaveValue("first line\nsecond line");
    expect(wire.state.sends).toHaveLength(0);
    await wire.input.press("Enter");
    await expect.poll(() => wire.state.sends.length).toBe(1);
    expect(wire.state.sends[0].prompt).toBe("first line\nsecond line");
    await expect(wire.input).toHaveValue("");
    await shot(page, "composer-desktop-700-enter-sent");
});

test("phone-width Zen 390x844 with a keyboard (fine pointer): Enter sends", async ({ page }) => {
    const { wire } = await openPhoneView(page, "zen", { viewport: PHONES[0] });
    await wire.setDetail({ status: "idle", acceptsTurnControl: false, activeTurnIndex: null });
    await expect(wire.sendButton).toHaveAttribute("data-action", "send");
    await expect(wire.input).toHaveAttribute("enterkeyhint", "send");
    await wire.input.fill("sent with the Enter key");
    await wire.input.press("Enter");
    await expect.poll(() => wire.state.sends.length).toBe(1);
    await expect(wire.input).toHaveValue("");
});

test("phone with a touch keyboard (390x844, touch, mobile): Enter adds a line; the button sends", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONES[0], isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
        const { wire } = await openPhoneView(page, "chat", { viewport: PHONES[0] });
        await wire.setDetail({ status: "idle", acceptsTurnControl: false, activeTurnIndex: null });
        await expect(wire.sendButton).toHaveAttribute("data-action", "send");
        await expect(wire.input).toHaveAttribute("enterkeyhint", "enter");
        await wire.input.fill("first line");
        await wire.input.press("Enter");
        await wire.input.pressSequentially("second line");
        await expect(wire.input).toHaveValue("first line\nsecond line");
        expect(wire.state.sends).toHaveLength(0);
        await wire.sendButton.tap();
        await expect.poll(() => wire.state.sends.length).toBe(1);
    } finally {
        await context.close();
    }
});

// The hold menu, in Chromium and WebKit: hold the blue button about 0.45 s
// (with typed text) and Steer now / Queue open above it, Steer now lit.
for (const browserName of ["chromium", "webkit"]) {
    test.describe(browserName, () => {
        for (const viewport of PHONES) {
            test(`phone ${viewport.width}x${viewport.height}: hold opens Steer now / Queue; slide to Queue queues; release on the button keeps it for a tap; a tap away sends nothing`, async () => {
                const browser = await ({ chromium, webkit }[browserName]).launch();
                const page = await browser.newPage();
                try {
                    const { wire } = await openPhoneView(page, "chat", { viewport });
                    // No browser long-press menu and no text selection on the button.
                    await wire.input.fill("compare with ClickHouse");
                    expect(await wire.sendButton.evaluate((el) => {
                        const style = getComputedStyle(el);
                        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
                        el.dispatchEvent(event);
                        return [style.userSelect || style.webkitUserSelect, style.touchAction, event.defaultPrevented];
                    })).toEqual(["none", "none", true]);

                    // Slide to Queue and release: queued, not steered.
                    await holdAndPick(wire, "queue");
                    await expect(queuedRows(wire).item.filter({ hasText: "compare with ClickHouse" })).toHaveAttribute("data-phase", "queued");
                    expect(wire.state.steers).toEqual([]);

                    // Release on the button: the menu stays, Steer now lit; a tap on it steers.
                    await wire.input.fill("prefer the shorter answer");
                    const menu = await holdOpen(wire);
                    await expect(menu.getByRole("menuitem", { name: /Steer now/ })).toHaveClass(/is-lit/);
                    await expect(menu.getByRole("menuitem")).toHaveCount(2);
                    if (browserName === "chromium") await shot(page, `composer-phone-${viewport.width}-hold-menu`);
                    await page.mouse.up();
                    await expect(menu).toBeVisible();
                    await menu.getByTestId("steer-hold-steer").click();
                    await expect(menu).toHaveCount(0);
                    await expect.poll(() => wire.state.steers.length).toBe(1);
                    expect(wire.state.steers[0]).toMatchObject({ text: "prefer the shorter answer" });
                    expect(wire.state.steers[0].replacesClientMessageId).toBeUndefined();

                    // Release away from the menu, or a tap away: nothing is sent; the text stays.
                    await wire.input.fill("not yet");
                    await holdOpen(wire);
                    await page.mouse.move(10, 10, { steps: 4 });
                    await page.mouse.up();
                    await expect(wire.composer.getByTestId("steer-hold-menu")).toHaveCount(0);
                    await holdOpen(wire);
                    await page.mouse.up();
                    await page.mouse.click(10, 10);
                    await expect(wire.composer.getByTestId("steer-hold-menu")).toHaveCount(0);
                    await expect(wire.input).toHaveValue("not yet");
                    expect(wire.state.steers).toHaveLength(1);
                    expect(wire.state.sends).toHaveLength(1);
                } finally {
                    await browser.close();
                }
            });
        }
    });
}

// A compact view (Zen, MoA panels) keeps the strip at the end of the
// transcript: a reader at the bottom follows it when it grows.
test("phone Zen (compact view): a reader at the bottom of a long transcript follows a new queued line", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const longChat = Array.from({ length: 60 }, (_, i) => ev(10 + i, "assistant.message", { content: `Earlier answer line ${i} with some words to fill the transcript.` }));
    const portal = await fakePortal(page, { sessions: { [SID]: { title: "Agent A", events: longChat }, [SID2]: { title: "Agent B" } } });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SID}`);
    await page.getByRole("button", { name: "Enter mobile zen", exact: true }).click();
    const zen = portal.wire(SID, { composerScope: page.locator(".ps-mobile-zen-composer") });
    await expect(zen.turnState).toHaveAttribute("data-accepts-controls", "true");
    await queueMessage(zen, "a first queued line");
    const scroller = page.locator(".ps-mobile-zen .ps-scroll-panel");
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await expect.poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(8);
    // Two frames: React has committed the follow state the scroll dispatched.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await queueMessage(zen, "a second queued line that the reader at the bottom must see");
    const line = queuedRows(zen).item.filter({ hasText: "a second queued line" });
    await expect.poll(() => line.evaluate((el) => {
        const panel = el.closest(".ps-scroll-panel").getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return box.top >= panel.top && box.bottom <= panel.bottom + 1;
    })).toBe(true);
});
