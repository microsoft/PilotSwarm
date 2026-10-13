// Session turn control in the portal: the data-testid contract of plan C3
// (the parent's UX pass asserts and screenshots these selectors). A fake
// transport answers every call: the hermetic stub server plus routed Web API
// calls and a routed WebSocket for live session events. Every selector and
// every attribute value of the contract table is reached here.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const SID = "11111110-2222-3333-4444-555555555550";
const T0 = 1785000000000;
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 0 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const ev = (seq, eventType, data) => ({ sessionId: SID, seq, eventType, createdAt: T0 + seq * 1000, data });

/**
 * Open the session with a scripted fake transport. `handlers` answer the
 * Stop/Steer/send routes (a function gets the route and the request body).
 */
async function open(page, { steering = true, detail = {}, events = [], canWrite = true, handlers = {} } = {}) {
    const state = {
        detail: { sessionId: SID, title: "Turn control", status: "running", activeTurnIndex: 3, turnHigh: 3, acceptsTurnControl: true,
            model: "github-copilot:claude-sonnet-5", createdAt: T0, updatedAt: T0, statusVersion: 1, ...detail },
        events: [...events],
        steers: [], stops: [], sends: [],
    };
    let socket;
    let subscribed = false;
    await page.routeWebSocket("**/api/v1/ws", (ws) => {
        socket = ws;
        ws.onMessage((raw) => { if (JSON.parse(raw).type === "subscribeLive") subscribed = true; });
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
        if (path.endsWith("/management/sessions")) return answer({ sessions: [state.detail], hasMore: false });
        if (path.endsWith(`/sessions/${SID}`)) return answer(state.detail);
        if (path.endsWith(`/sessions/${SID}/access`)) {
            return answer({ visibility: "private", relation: canWrite ? "owner" : "collaborator", canWrite, canManage: canWrite,
                owner: { provider: "none", subject: "owner", displayName: "Owner" } });
        }
        if (path.endsWith(`/management/sessions/${SID}/events`)) {
            const after = Number(url.searchParams.get("afterSeq") || 0);
            return answer(state.events.filter((event) => event.seq > after));
        }
        if (path.endsWith("/steer")) {
            const body = request.postDataJSON();
            state.steers.push(body.options);
            return handlers.steer ? handlers.steer({ route, body: body.options, answer, fail, state }) : answer({ outcome: "accepted", steerId: 900 + state.steers.length, turn: 3 });
        }
        if (path.endsWith("/stop-turn")) {
            const body = request.postDataJSON();
            state.stops.push(body.options);
            return handlers.stop ? handlers.stop({ route, body: body.options, answer, fail, state }) : answer({ outcome: "stopped", turnIndex: 3, controlSeq: 950 });
        }
        if (path.endsWith(`/sessions/${SID}/messages`)) {
            const body = request.postDataJSON();
            state.sends.push(body);
            return handlers.send ? handlers.send({ route, body, answer, fail, state }) : answer({ queued: true });
        }
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SID}`);
    await expect.poll(() => subscribed).toBe(true);
    let liveSeq = 1_000_000;
    const composer = page.locator(`.ps-prompt-shell[data-session-id="${SID}"]`);
    const transcript = page.locator(`.ps-scroll-panel[data-session-id="${SID}"]`);
    const wire = {
        state, composer, transcript,
        input: composer.getByTestId("composer-input"),
        steerButton: composer.getByTestId("turn-steer-button"),
        stopButton: composer.getByTestId("turn-stop-button"),
        turnState: composer.getByTestId("session-turn-state"),
        notice: composer.getByTestId("control-notice"),
        /** Push a durable session event over the live channel (seq above the REST window). */
        event(eventType, data) {
            const event = { sessionId: SID, seq: ++liveSeq, eventType, createdAt: Date.now(), data };
            state.events.push(event);
            socket.send(JSON.stringify({ type: "sessionEvent", sessionId: SID, event }));
            return event.seq;
        },
        /** Change the detailed view; the event makes the portal re-read it. */
        async setDetail(fields) {
            Object.assign(state.detail, fields, { statusVersion: state.detail.statusVersion + 1 });
            this.event("assistant.usage", {});
        },
    };
    return wire;
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
    await expect(wire.turnState).toBeVisible();
    await expect(wire.turnState).toHaveText("running");
    for (const status of ["pending", "idle", "waiting", "input_required", "error", "failed", "completed", "cancelled", "running"]) {
        await wire.setDetail({ status, acceptsTurnControl: status === "running" });
        await expect(wire.turnState).toHaveAttribute("data-turn-state", status);
        await expect(wire.turnState).toHaveText(status.replace(/_/g, " "));
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

test("every Stop notice: no active turn, timeout, pending retry, unconfirmed with Retry, forbidden, error", async ({ page }) => {
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
    await press(({ answer }) => answer({ outcome: "timeout", turnIndex: 3, controlSeq: 3_000_000 }), "stop_pending_retry");
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
