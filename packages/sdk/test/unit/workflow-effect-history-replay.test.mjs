import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowEffect_1_0_0 } from "../../dist/workflow/effect_1_0_0/index.js";
import { workflowEffect_1_1_0 } from "../../dist/workflow/effect_1_1_0/index.js";
import { registerWorkflow, workflowEffect, workflowDecisionEffect } from "../../dist/workflow/runtime.js";

const recording = JSON.parse(readFileSync(new URL("../fixtures/workflow-effect-1-0-0-history.json", import.meta.url)));
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function context() {
    return {
        scheduleActivityTyped: (name, input) => ({
            kind: "activity", name, input,
            withTag(tag) { this.tag = tag; return this; },
        }),
        scheduleTimer: ms => ({ kind: "timer", ms }),
    };
}

/** Feed a fixture verbatim. Neither scenario nor task logic chooses an answer during replay. */
function replayEffectHistory(history) {
    const generator = workflowEffect_1_0_0(context(), copy(history.input));
    let next;
    let failure = null;
    let failedAt = -1;
    try { next = generator.next(); }
    catch (error) { failure = error; failedAt = 0; }

    for (const [index, event] of history.events.entries()) {
        assert.equal(failure, null, `${history.scenario} failed before event ${index}`);
        assert.equal(next.done, false, `${history.scenario} ended before event ${index}`);
        const actual = copy(next.value);
        assert.deepEqual(actual, event.task, `${history.scenario} schedule diverged at event ${index}`);
        if (Object.hasOwn(actual, "input")) {
            assert.equal(JSON.stringify(actual.input), JSON.stringify(event.task.input), `${history.scenario} input bytes diverged at event ${index}`);
        }
        try {
            next = Object.hasOwn(event, "throw")
                ? generator.throw(new Error(event.throw))
                : generator.next(copy(event.reply));
        } catch (error) {
            failure = error;
            failedAt = index;
        }
    }

    if (history.throws) {
        assert.ok(failure instanceof Error, `${history.scenario} did not throw`);
        assert.equal(failedAt, history.events.length - 1, `${history.scenario} threw at the wrong event`);
        assert.deepEqual({ name: failure.name, message: failure.message }, history.throws);
        return;
    }
    assert.equal(failure, null, `${history.scenario} unexpectedly threw`);
    assert.equal(next.done, true, `${history.scenario} scheduled extra work`);
    assert.deepEqual(copy(next.value), history.result);
}

test("the registered effect handlers are the frozen 1.0 script and distinct 1.1 Decision modules", () => {
    const registered = [];
    registerWorkflow({
        registerActivity() {},
        registerOrchestrationVersioned(name, version, fn) { registered.push({ name, version, fn }); },
    }, { store: {} });
    const effects = registered.filter(entry => entry.name === "workflow-effect");
    assert.deepEqual(effects.map(entry => entry.version), ["1.0.0", "1.1.0", "1.2.0"]);
    assert.equal(effects[0].fn, workflowEffect_1_0_0);
    assert.equal(effects[1].fn, workflowEffect_1_1_0);
    assert.equal(workflowEffect, workflowEffect_1_0_0);
    assert.equal(workflowDecisionEffect, workflowEffect_1_1_0);
    assert.notEqual(effects[0].fn, effects[1].fn);
});

test("the script-effect fixture records the pre-freeze 1.0 provenance", () => {
    assert.deepEqual(recording.source, {
        commit: "8fa834e76a3214fe8ec1b5d4334efc59e5b138a2",
        version: "1.0.0",
        description: "script-only workflow-effect schedule before extraction into its frozen module",
    });
    assert.deepEqual(recording.histories.map(history => history.scenario), [
        "script-success-exact-inputs",
        "script-error-recorded-once",
        "record-retries-same-outcome",
        "wake-exhausts-five-attempts",
    ]);
});

for (const history of recording.histories) {
    test(`frozen 1.0 replays recorded script effect: ${history.scenario}`, () => {
        assert.equal(history.version, "1.0.0");
        replayEffectHistory(history);
    });
}
