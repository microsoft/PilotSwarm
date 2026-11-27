// What a canvas button press looks like in the transcript once the runtime
// has finished with it.
//
// A press does not reach history as the bare `[canvas-action] {…}` the browser
// sent. By the time it is an event, two other layers have written on it:
//
//   1. Multi-writer attribution prefixes `[FROM: Ada Admin (admin)]`.
//   2. An interrupted timer appends `[SYSTEM: … timer …]` to the same text.
//   3. The forged-marker neutralizer inserts a ZERO-WIDTH SPACE after `[` in
//      any `[SYSTEM:` when the sender is not the session owner — and it runs
//      AFTER step 2, so it defangs the runtime's OWN notice.
//
// Both bugs this pins were visible at once in a shared session: the press
// printed as an ordinary chat line showing raw JSON, and the timer notice
// printed as prose under it.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel } from "../src/history.js";
import { selectChatLines } from "../src/selectors.js";
import { appReducer, createInitialState, createStore, PilotSwarmUiController } from "../src/index.js";

const ZWSP = "​";
const NOTICE = "The above is a message that interrupted your 21600s timer "
    + '(reason: "no provider"). 560s elapsed, 21040s remain. '
    + "Reply to the message. The timer will be automatically resumed after your reply.";

function userEvent(seq, content) {
    return {
        seq,
        sessionId: "s1",
        eventType: "user.message",
        createdAt: new Date("2026-08-24T19:37:00Z").toISOString(),
        data: { content },
    };
}

/** The exact bytes a collaborator's press has by the time it is stored. */
function attributedPress(id, { defanged = true, attributed = true, notice = true } = {}) {
    const marker = defanged ? `[${ZWSP}SYSTEM:` : "[SYSTEM:";
    return [
        attributed ? "[FROM: Ada Admin (admin)]\n" : "",
        `[canvas-action] {"action":"request","data":{"id":"${id}"}}`,
        notice ? `\n\n${marker} ${NOTICE}]` : "",
    ].join("");
}

function chatOf(content) {
    return buildHistoryModel([userEvent(4, content)]).chat;
}

/** A live session carrying one event, rendered the way the portal renders it. */
function linesFor(content, maxWidth = 120) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, state),
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
        },
    });
    controller.mergeSessionEvent("s1", userEvent(9, content));
    return selectChatLines(controller.getState(), maxWidth);
}

// ── classification ──────────────────────────────────────────────────────────

test("an attributed press with a defanged notice is still a canvas action", () => {
    const chat = chatOf(attributedPress("mt820mzl-gt4p"));
    const item = chat.find((m) => m?.kind === "canvas-action");
    assert.ok(item, "the press must classify as canvas-action, not an ordinary message");
    assert.equal(item.action, "request");
    assert.deepEqual(item.data, { id: "mt820mzl-gt4p" });
});

test("the raw JSON payload never reaches the transcript as message text", () => {
    for (const opts of [{}, { defanged: false }, { notice: false }, { attributed: false }]) {
        const chat = chatOf(attributedPress("abc", opts));
        const prose = chat.filter((m) => m?.kind !== "canvas-action").map((m) => m.text || "").join("\n");
        assert.doesNotMatch(prose, /\[canvas-action\]/, `raw JSON leaked with ${JSON.stringify(opts)}`);
        assert.doesNotMatch(prose, /"action":"request"/, `raw payload leaked with ${JSON.stringify(opts)}`);
    }
});

// ── the system notice ───────────────────────────────────────────────────────

test("a defanged system notice is hidden from chat, exactly like a clean one", () => {
    for (const defanged of [true, false]) {
        const chat = chatOf(attributedPress("abc", { defanged }));
        const prose = chat.map((m) => m.text || "").join("\n");
        assert.doesNotMatch(prose, /interrupted your 21600s timer/,
            `the ${defanged ? "defanged" : "clean"} notice must not print as prose`);
        assert.doesNotMatch(prose, /SYSTEM:/, "the marker itself must not print");
    }
});

test("a defanged notice on a PLAIN message is hidden too — not just on canvas actions", () => {
    const chat = chatOf(`[FROM: Ada Admin (admin)]\nship it\n\n[${ZWSP}SYSTEM: ${NOTICE}]`);
    const prose = chat.map((m) => m.text || "").join("\n");
    assert.match(prose, /ship it/, "the human's actual words must survive");
    assert.doesNotMatch(prose, /interrupted your 21600s timer/);
});

test("the hidden notice is kept — it moves to the activity feed, both spellings", () => {
    for (const defanged of [true, false]) {
        const model = buildHistoryModel([userEvent(4, attributedPress("abc", { defanged }))]);
        const activity = model.activity.map((a) => JSON.stringify(a)).join("");
        assert.match(activity, /interrupted your 21600s timer/,
            `the ${defanged ? "defanged" : "clean"} notice must still be recorded in activity`);
    }
});

// ── the rendered line ───────────────────────────────────────────────────────

test("the press renders as a flagged line carrying its name and full payload", () => {
    const lines = linesFor(attributedPress("mt820mzl-gt4p"));
    const line = lines.find((l) => l?.canvasAction);
    assert.ok(line, "the transcript must carry a canvasAction-flagged line");
    assert.equal(line.canvasActionName, "request");
    // The portal opens this row to show the payload, so it must be the whole
    // object — not the 120-char summary the TUI runs are truncated to.
    assert.match(line.canvasActionPayload, /"id": "mt820mzl-gt4p"/);
    assert.doesNotMatch(JSON.stringify(lines), /\[canvas-action\]/,
        "no rendered line may show the raw wire format");
});

test("a long payload stays whole in the body while the one-line summary truncates", () => {
    const note = "x".repeat(400);
    const content = `[FROM: Ada Admin (admin)]\n[canvas-action] ${JSON.stringify({
        action: "store",
        data: { id: "req-9", note, kind: "artifact" },
    })}`;
    const line = linesFor(content).find((l) => l?.canvasAction);
    assert.ok(line);
    // The collapsed row must stay one line…
    assert.ok(line.canvasActionDetail.length <= 120, "the summary detail must be truncated");
    // …but opening it shows every field, or the row is useless for diagnosis.
    assert.match(line.canvasActionPayload, /"kind": "artifact"/);
    assert.ok(line.canvasActionPayload.includes(note), "the full note must survive into the body");
});

// ── merged turns (queue prompt batching) ────────────────────────────────────

function userEventWith(seq, data, createdAt = "2026-11-27T06:43:00Z") {
    return {
        seq,
        sessionId: "s1",
        eventType: "user.message",
        createdAt: new Date(createdAt).toISOString(),
        data,
    };
}

function liveAndBulk(events) {
    const bulk = buildHistoryModel(events);
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, state),
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
        },
    });
    for (const evt of events) controller.mergeSessionEvent("s1", evt);
    const live = controller.getState().history.bySessionId.get("s1");
    return { bulk, live, state: controller.getState() };
}

const OWNER_SENDER = { kind: "user", provider: "entra", subject: "affan", display: "Affan Dar", relation: "owner" };
const ADMIN_SENDER = { kind: "user", provider: "entra", subject: "ada", display: "Ada Admin", relation: "admin" };

test("merged canvas action + typed text splits in order into a card and an ordinary user message", () => {
    const content = '[canvas-action] {"action":"decide","data":{"id":"i7-answers","choice":"accept-all"}}\n\nok what was the thing I wanted to discuss?';
    const evt = userEventWith(10, { content, sender: OWNER_SENDER, clientMessageIds: ["msg-1"] });
    const { bulk, live, state } = liveAndBulk([evt]);

    for (const [label, model] of [["bulk", bulk], ["live", live]]) {
        assert.equal(model.chat.length, 2, `${label}: expected card + user message`);
        assert.equal(model.chat[0].kind, "canvas-action", `${label}: first item must be canvas-action`);
        assert.equal(model.chat[0].id, "s1:10");
        assert.equal(model.chat[0].action, "decide");
        assert.deepEqual(model.chat[0].data, { id: "i7-answers", choice: "accept-all" });
        assert.equal(model.chat[0].clientMessageIds, undefined, `${label}: single typed id stays on text item, not card`);

        assert.equal(model.chat[1].kind, undefined, `${label}: second item must be ordinary user message`);
        assert.equal(model.chat[1].role, "user");
        assert.notEqual(model.chat[1].id, model.chat[0].id, `${label}: split items must have unique ids`);
        assert.equal(model.chat[1].text, "ok what was the thing I wanted to discuss?");
        assert.deepEqual(model.chat[1].clientMessageIds, ["msg-1"]);
        assert.deepEqual(model.chat[1].sender, OWNER_SENDER);
        assert.notEqual(model.chat[1].redelivered, true);

        const canvasActivity = model.activity.filter((a) => a.id.includes(":canvas-action"));
        assert.equal(canvasActivity.length, 1, `${label}: one canvas activity line`);
        assert.match(canvasActivity[0].text, /decide/);
    }

    const lines = selectChatLines(state, 120);
    const cardLines = lines.filter((l) => l?.canvasAction);
    assert.equal(cardLines.length, 1);
    assert.equal(cardLines[0].canvasActionName, "decide");
    assert.match(cardLines[0].canvasActionPayload, /"choice": "accept-all"/);
    // TUI compact line runs must also carry the action name, never raw JSON prose.
    assert.match(cardLines[0].runs.map((r) => r.text).join(""), /\[canvas\] decide/);
    assert.doesNotMatch(JSON.stringify(lines), /\[canvas-action\]/);
    assert.match(JSON.stringify(lines), /ok what was the thing I wanted to discuss\?/);
});

test("two merged canvas actions split into two cards and two activity lines without false redelivery", () => {
    const content = [
        '[canvas-action] {"action":"decide","data":{"id":"a"}}',
        '[canvas-action] {"action":"decide","data":{"id":"b"}}',
    ].join("\n\n");
    const evt = userEventWith(12, { content, sender: OWNER_SENDER });
    const { bulk, live, state } = liveAndBulk([evt]);

    for (const [label, model] of [["bulk", bulk], ["live", live]]) {
        assert.equal(model.chat.length, 2, `${label}: two cards, no blank text item`);
        assert.equal(model.chat[0].kind, "canvas-action");
        assert.equal(model.chat[1].kind, "canvas-action");
        assert.equal(model.chat[0].id, "s1:12");
        assert.notEqual(model.chat[1].id, model.chat[0].id);
        assert.deepEqual(model.chat[0].data, { id: "a" });
        assert.deepEqual(model.chat[1].data, { id: "b" });
        assert.notEqual(model.chat[0].redelivered, true);
        assert.notEqual(model.chat[1].redelivered, true);

        const canvasActivity = model.activity.filter((a) => a.id.includes(":canvas-action"));
        assert.equal(canvasActivity.length, 2, `${label}: one activity line per action`);
        assert.notEqual(canvasActivity[0].id, canvasActivity[1].id);
    }

    const lines = selectChatLines(state, 120);
    assert.equal(lines.filter((l) => l?.canvasAction).length, 2);

    // Two identical merged presses with no clientMessageIds must NOT collapse as redelivered.
    const sameContent = [
        '[canvas-action] {"action":"refresh","data":{}}',
        '[canvas-action] {"action":"refresh","data":{}}',
    ].join("\n\n");
    const { bulk: sameBulk, live: sameLive } = liveAndBulk([userEventWith(13, { content: sameContent })]);
    for (const [label, model] of [["bulk", sameBulk], ["live", sameLive]]) {
        assert.equal(model.chat.length, 2, `${label}: identical merged presses must not collapse`);
        assert.ok(model.chat.every((m) => m.kind === "canvas-action" && !m.redelivered));
    }
});

test("text + canvas action + text preserves order and maps matching clientMessageIds", () => {
    const content = [
        "first thought",
        '[canvas-action] {"action":"approve","data":{"step":1}}',
        "second thought",
    ].join("\n\n");

    // Case 1: ids match the 2 text segments (canvas action had no id).
    const evtTextIds = userEventWith(20, { content, sender: OWNER_SENDER, clientMessageIds: ["m-1", "m-2"] });
    const { bulk: b1, live: l1 } = liveAndBulk([evtTextIds]);
    for (const [label, model] of [["bulk", b1], ["live", l1]]) {
        assert.equal(model.chat.length, 3, `${label}: text + action + text`);
        assert.equal(model.chat[0].role, "user");
        assert.equal(model.chat[0].kind, undefined);
        assert.equal(model.chat[0].text, "first thought");
        assert.deepEqual(model.chat[0].clientMessageIds, ["m-1"]);

        assert.equal(model.chat[1].kind, "canvas-action");
        assert.equal(model.chat[1].action, "approve");
        assert.equal(model.chat[1].clientMessageIds, undefined);

        assert.equal(model.chat[2].role, "user");
        assert.equal(model.chat[2].kind, undefined);
        assert.equal(model.chat[2].text, "second thought");
        assert.deepEqual(model.chat[2].clientMessageIds, ["m-2"]);

        assert.equal(new Set(model.chat.map((m) => m.id)).size, 3);
    }

    // Case 2: ids match all 3 merged segments 1:1.
    const evtAllIds = userEventWith(21, { content, sender: OWNER_SENDER, clientMessageIds: ["m-1", "a-1", "m-2"] });
    const { bulk: b2, live: l2 } = liveAndBulk([evtAllIds]);
    for (const [label, model] of [["bulk", b2], ["live", l2]]) {
        assert.equal(model.chat.length, 3, `${label}: 1:1 id mapping`);
        assert.deepEqual(model.chat[0].clientMessageIds, ["m-1"]);
        assert.deepEqual(model.chat[1].clientMessageIds, ["a-1"]);
        assert.deepEqual(model.chat[2].clientMessageIds, ["m-2"]);
    }
});

test("merged multi-writer [FROM: ...] canvas action + typed text + embedded [SYSTEM: ...] notice", () => {
    const content = [
        `[FROM: Ada Admin (admin)]\n[canvas-action] {"action":"decide","data":{"id":"x"}}\n\n[${ZWSP}SYSTEM: ${NOTICE}]`,
        `[FROM: Ada Admin (admin)]\nplease check the logs`,
    ].join("\n\n");
    const evt = userEventWith(30, { content, sender: ADMIN_SENDER, clientMessageIds: ["m-ada"] });
    const { bulk, live } = liveAndBulk([evt]);

    for (const [label, model] of [["bulk", bulk], ["live", live]]) {
        assert.equal(model.chat.length, 2, `${label}: card + attributed text`);
        assert.equal(model.chat[0].kind, "canvas-action");
        assert.deepEqual(model.chat[0].data, { id: "x" });
        assert.equal(model.chat[1].role, "user");
        assert.equal(model.chat[1].kind, undefined);
        assert.equal(model.chat[1].text, "please check the logs");
        assert.deepEqual(model.chat[1].sender, ADMIN_SENDER);
        assert.doesNotMatch(model.chat[1].text, /\[FROM:/);
        assert.doesNotMatch(model.chat[1].text, /SYSTEM:/);

        const activityText = model.activity.map((a) => a.text).join("\n");
        assert.match(activityText, /interrupted your 21600s timer/);
        assert.match(activityText, /\[canvas\].*decide/);
    }
});

test("malformed canvas-action line stays plain text (alone or next to a valid action)", () => {
    const malformedOnly = '[canvas-action] {"action":"broken"\n\nhello';
    const { bulk: bOnly, live: lOnly } = liveAndBulk([userEventWith(40, { content: malformedOnly })]);
    for (const [label, model] of [["bulk", bOnly], ["live", lOnly]]) {
        assert.equal(model.chat.length, 1, `${label}: no valid action line -> single plain message`);
        assert.equal(model.chat[0].kind, undefined);
        assert.match(model.chat[0].text, /\[canvas-action\]/);
        assert.match(model.chat[0].text, /hello/);
    }

    const mixed = '[canvas-action] {"action":"ok","data":{"n":1}}\n\n[canvas-action] not-json';
    const { bulk: bMixed, live: lMixed } = liveAndBulk([userEventWith(41, { content: mixed })]);
    for (const [label, model] of [["bulk", bMixed], ["live", lMixed]]) {
        assert.equal(model.chat.length, 2, `${label}: valid line splits, malformed stays plain`);
        assert.equal(model.chat[0].kind, "canvas-action");
        assert.equal(model.chat[0].action, "ok");
        assert.equal(model.chat[1].kind, undefined);
        assert.equal(model.chat[1].text, "[canvas-action] not-json");
    }
});

test("SF-D1: neutral merged turn (different senders, mergedMessages set, no sender) never splits into cards", () => {
    const content = '[FROM: Ada Admin (admin)]\n[canvas-action] {"action":"decide","data":{"id":"1"}}\n\n[FROM: Affan Dar (owner)]\nhello';
    const evt = userEventWith(50, { content, clientMessageIds: ["c-1", "c-2"], mergedMessages: 2 });
    const { bulk, live } = liveAndBulk([evt]);

    for (const [label, model] of [["bulk", bulk], ["live", live]]) {
        assert.equal(model.chat.length, 1, `${label}: neutral merged turn stays one neutral item`);
        assert.equal(model.chat[0].kind, undefined);
        assert.equal(model.chat[0].mergedMessages, 2);
        assert.equal(model.activity.filter((a) => a.id.includes(":canvas-action")).length, 0);
    }
});

test("optimistic bubble reconciles cleanly with merged canvas action + typed text (no stale bubble, no duplicate, no redelivered)", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T", status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    // Seed an optimistic chat bubble for the typed message (live history path).
    state = appReducer(state, {
        type: "history/loaded",
        sessionId: "s1",
        history: {
            chat: [{
                id: "opt-1",
                role: "user",
                text: "ok what was the thing I wanted to discuss?",
                createdAt: Date.parse("2026-11-27T06:42:58Z"),
                optimistic: true,
                clientMessageIds: ["msg-42"],
            }],
            activity: [],
            events: [],
            lastSeq: 0,
        },
    });
    // Also seed a pending outbox entry for the same typed message.
    state = appReducer(state, {
        type: "outbox/updated",
        sessionId: "s1",
        items: [{
            id: "msg-42",
            text: "ok what was the thing I wanted to discuss?",
            createdAt: Date.parse("2026-11-27T06:42:58Z"),
            phase: "queued",
            clientMessageIds: ["msg-42"],
        }],
    });

    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, state),
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
        },
    });

    controller.mergeSessionEvent("s1", userEventWith(60, {
        content: '[canvas-action] {"action":"decide","data":{"id":"i7"}}\n\nok what was the thing I wanted to discuss?',
        sender: OWNER_SENDER,
        clientMessageIds: ["msg-42"],
    }));

    const nextState = controller.getState();
    const chat = nextState.history.bySessionId.get("s1").chat;
    assert.equal(chat.length, 2, "must have exactly 1 card + 1 durable text message");
    assert.equal(chat.filter((m) => m.optimistic).length, 0, "no stale optimistic bubble");
    assert.equal(chat[0].kind, "canvas-action");
    assert.equal(chat[1].role, "user");
    assert.equal(chat[1].text, "ok what was the thing I wanted to discuss?");
    assert.deepEqual(chat[1].clientMessageIds, ["msg-42"]);
    assert.notEqual(chat[1].redelivered, true, "must not be flagged redelivered");
    assert.equal(controller.getSessionOutbox("s1").length, 0, "outbox item reconciled");

    const lines = selectChatLines(nextState, 120);
    const matches = JSON.stringify(lines).match(/ok what was the thing I wanted to discuss\?/g) || [];
    assert.equal(matches.length, 1, "typed text must appear once, never duplicated");
});

test("single-action path output is unchanged", () => {
    const content = '[canvas-action] {"action":"approve","data":{"id":42}}';
    const evt = userEventWith(70, { content, clientMessageIds: ["c-single"] });
    const { bulk, live } = liveAndBulk([evt]);
    const expected = {
        id: "s1:70",
        kind: "canvas-action",
        role: "user",
        action: "approve",
        data: { id: 42 },
        text: content,
        time: bulk.chat[0].time,
        createdAt: Date.parse("2026-11-27T06:43:00Z"),
        clientMessageIds: ["c-single"],
    };
    assert.deepEqual(bulk.chat, [expected]);
    assert.deepEqual(live.chat, [expected]);
    assert.equal(bulk.activity.length, 1);
    assert.equal(bulk.activity[0].id, "s1:70:canvas-action");
});
