import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_PATTERN_MAX_LENGTH, unsafeSchemaPattern } from "../../dist/workflow/v2/schema.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";

// Adversarial review SF-5: a schema pattern that could take exponential time on a small input is refused when the
// definition is compiled; ordinary patterns keep working.

test("nested repeats and repeated overlapping alternatives are refused", () => {
    for (const pattern of ["^(a+)+$", "(a*)*", "((ab)*)+", "(.*a){10}", "(a|ab)*", "(a|a)+", "(\\w|\\d)+", "(x|.)*", "(|a)+", "(?:a+)+b",
        "(a{2,})*", "(\\d+\\d)+", "([^x]+y)*", "(\\D|x)+"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /repeat|alternatives/, pattern);
    }
});

test("ordinary patterns are accepted", () => {
    for (const pattern of ["^[a-z0-9-]+$", "^\\d{4}-\\d{2}-\\d{2}$", "^(foo|bar)$", "^(foo|bar)+$", "^[A-Z]{2,3}$", "^(\\d+)?$", "(ab)*", "^a+b+c+$",
        "^[^\\]]+$", "^\\(\\d+\\)$", "^(?:https?)://[^\\s]+$", "^(a{1})+$",
        // Separated repeats split a string in one way.
        "([a-z]+\\.)+[a-z]+", "^v\\d+(\\.\\d+){0,2}$", "^((\\.\\d+)*;)+$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
});

test("a pattern longer than the limit, or with unmatched parentheses, is refused", () => {
    assert.equal(SCHEMA_PATTERN_MAX_LENGTH, 512);
    assert.equal(unsafeSchemaPattern("a".repeat(512)), null);
    assert.match(unsafeSchemaPattern("a".repeat(513)), /at most 512 characters/);
    assert.match(unsafeSchemaPattern("(a"), /unmatched '\('/);
    assert.match(unsafeSchemaPattern("a)"), /unmatched '\)'/);
});

const docWith = schema => JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "patterns", version: "1.0.0" },
    inputs: { schema }, initial: "pause",
    states: {
        pause: { type: "wait", seconds: 1, transition: { next: { elapsed: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
});

test("the compiler refuses an unsafe pattern or patternProperties name, and takes a safe one", () => {
    const unsafe = compileWorkflowV2(docWith({ type: "object", properties: { name: { type: "string", pattern: "^(a+)+$" } } }));
    assert.equal(unsafe.valid, false);
    assert.ok(unsafe.diagnostics.some(item => item.severity === "error" && /unsafe pattern/.test(item.message)), JSON.stringify(unsafe.diagnostics));
    const keys = compileWorkflowV2(docWith({ type: "object", patternProperties: { "^(x|xy)*$": { type: "string" } } }));
    assert.equal(keys.valid, false);
    assert.ok(keys.diagnostics.some(item => /unsafe pattern/.test(item.message)));
    const safe = compileWorkflowV2(docWith({ type: "object", properties: { name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" } } }));
    assert.equal(safe.valid, true, JSON.stringify(safe.diagnostics));
});

// Verification of SF-5 and VR-4 (M-05).
test("SF-5: an alternative nested in a repeated group is compared by all its first characters: ^((a|b)|aa)+$ is refused", () => {
    for (const pattern of ["^((a|b)|aa)+$", "^((b|a)|aa)+$", "^(((x|a))|a[0-9])*$", "^(?:(?:a|b)|(?:c|a))+$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /alternatives that can start the same way/, pattern);
    }
});

test("VR-4: fixed counts and disjoint alternatives are accepted, ordinary formats included", () => {
    for (const pattern of ["^([0-9]{2}-){2}[0-9]{2}$", "^(\\d{1,3}\\.){3}\\d{1,3}$", "^((a|b)c)+$", "^([a-c]|[x-z])+$", "^(?:[A-Z][a-z]+ )+$",
        "^([0-9a-f]{2}:){5}[0-9a-f]{2}$", "^(\\w{4}-){3}\\w{4}$", "^(ab|cd){1,40}$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
});

test("SF-5 known limit: repeats side by side are accepted (their cost grows as a power, not exponentially)", () => {
    for (const pattern of ["^a*a*$", "^\\d+\\d+$"]) assert.equal(unsafeSchemaPattern(pattern), null, pattern);
});

test("escapes and classes", () => {
    // Escaped and class characters are characters, not syntax.
    assert.equal(unsafeSchemaPattern("^(\\(|\\))+$"), null);
    assert.equal(unsafeSchemaPattern("^([\\]a]|b)+$"), null);
    assert.match(unsafeSchemaPattern("^([\\]a]|a)+$") ?? "", /alternatives/);
    assert.equal(unsafeSchemaPattern("^(\\u0041|B)+$"), null);
    assert.match(unsafeSchemaPattern("^(\\u0041|A)+$") ?? "", /alternatives/);
    // A negated class can start like anything it does not exclude.
    assert.match(unsafeSchemaPattern("^([^b]|a)+$") ?? "", /alternatives/);
    assert.equal(unsafeSchemaPattern("^([^a]|a)+$"), null);
    assert.match(unsafeSchemaPattern("^[a-z"), /unclosed class/);
});

// Verification of SF-5 in E2 (E2-R1, E2-R5; tests E2-T1 to E2-T3). Compile-time checks only: no hostile pattern is run.
test("E2-T1: a lookaround's body is checked as any other part", () => {
    for (const pattern of ["^(?=(a+)+$)a*$", "^(?!(a|a)+$)\\w+$", "(?<=(x+)+)y", "^(?<!(\\d+\\d)+)z$", "^(?=.*(a|ab)*c)"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /repeat|alternatives/, pattern);
    }
    for (const pattern of ["^(?=.*\\d)(?=.*[a-z])[a-z\\d]{8,}$", "^(?!www\\.)[a-z.]+$", "(?<=\\$)\\d+"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
});

test("E2-T1: a negated class is computed from its members, and a Unicode property overlaps everything", () => {
    // [^\D] is the digits, [^\W] the word characters: they overlap what follows them.
    for (const pattern of ["^([^\\D]+\\d)+$", "^([^\\W]+a)+$", "^([^\\S]+ )+$", "^([^\\D]|5)+$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /repeat|alternatives/, pattern);
    }
    // A property is not computed, negated or not, in a class or not.
    for (const pattern of ["^(\\p{L}+x)+$", "^([^\\p{L}]+x)+$", "^(\\P{L}|x)+$", "^([\\p{Lu}a]+-)+$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /repeat|alternatives/, pattern);
    }
    // Exact sets still tell disjoint characters apart.
    for (const pattern of ["^([^\\D]+-)+$", "^([\\D\\d]{2})+$", "^(\\p{L}{3})+$", "^\\p{L}+$", "^([^\\D]|x)+$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
    assert.match(unsafeSchemaPattern("^[z-a]$") ?? "", /out of order/);
});

test("E2-T2: the check's work is bounded on deep, wide and nullable patterns of the longest length", () => {
    const patterns = [
        "(".repeat(256) + ")".repeat(256),
        "(".repeat(170) + "a" + ")*".repeat(170),
        "(" + "x?|".repeat(169) + "y)*",
        "(" + "a?".repeat(254) + ")*",
        "(" + "[^\\D]?".repeat(84) + ")+",
        "^(?:" + "(?=a)".repeat(100) + "b)+$",
        "[" + "a-b".repeat(170) + "]+",
        "^(" + "[a-c]|".repeat(84) + "x)+$",
        // Accepted only after all the work: 250 disjoint alternatives, and 169 short repeats each stopped by a letter.
        "^(" + Array.from({ length: 250 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("|") + ")+$",
        "(" + "a?b".repeat(169) + ")*",
    ].map(pattern => pattern.slice(0, 512));
    for (const pattern of patterns) {
        assert.ok(pattern.length <= 512);
        const started = process.hrtime.bigint();
        const reason = unsafeSchemaPattern(pattern);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        assert.ok(reason === null || typeof reason === "string", pattern.slice(0, 40));
        assert.ok(ms < 500, `${pattern.slice(0, 40)}… took ${ms} ms`);
    }
    assert.equal(unsafeSchemaPattern(patterns.at(-2)), null);
    assert.equal(unsafeSchemaPattern(patterns.at(-1)), null);
});

test("E2-T3: modifier groups are groups; under i a letter matches its other case", () => {
    // Accepted again, as before E2: existing definitions keep compiling.
    for (const pattern of ["^(?i:abc)$", "^(?i:a|b)+$", "^(?-i:x)$", "^(?s:.)+$", "^(?ms:a.b)$", "^(?i-s:[a-z]+)$", "^(?i:[a-z]{2}-)+$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
    // Their bodies are checked, with the case they read.
    for (const pattern of ["^(?i:(a|A)+)$", "^(?i:([a-z]+K)+)$", "^(?i:(x+)+)$", "^(?i:(k|\\u212A)+)$", "^(?i:(\\w|\\u017F)+)$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /repeat|alternatives/, pattern);
    }
    // Without i, the same letters of two cases are disjoint.
    for (const pattern of ["^(a|A)+$", "^([a-z]+K)+$", "^(?-i:(a|A)+)$", "^(?i:(?-i:(a|A)+))$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
    // A letter beyond ASCII under i is not computed: it overlaps everything.
    assert.match(unsafeSchemaPattern("^(?i:(\u00e9+x)+)$") ?? "", /repeat/);
    // Unknown, repeated or missing flags are refused.
    for (const pattern of ["^(?x:a)$", "^(?ii:a)$", "^(?i-i:a)$", "^(?-:a)$", "^(?g:a)$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /modifier group/, pattern);
    }
    assert.match(unsafeSchemaPattern("^(?a)$") ?? "", /unknown group/);
    // Named groups keep working, long names included.
    assert.equal(unsafeSchemaPattern("^(?<aVeryLongGroupNameIndeed>[a-z]+)-\\d$"), null);
});

test("a negated escape and a character it excludes do not overlap", () => {
    assert.equal(unsafeSchemaPattern("^(\\D|1)+$"), null);
});

// Verification of E2b-high (E2bH-SF5-1; test E2bH-T1, compile-time only): a surrogate pair written as two \u escapes is
// one character, the same as the character itself and as \u{...}.
test("E2bH-T1: a surrogate pair escape is one character, the same atom as the character written as it is", () => {
    for (const pattern of ["^(?:\\uD83D\\uDE00|\u{1F600}\u{1F600})+$", "^(?:\\u{1F600}|\u{1F600}\u{1F600})+$", "^(?:\\uD83D\\uDE00|\\u{1F600}x)+$",
        "^([\\uD83D\\uDE00]|\u{1F600})+$"]) {
        assert.match(unsafeSchemaPattern(pattern) ?? "", /alternatives that can start the same way/, pattern);
    }
    // Different characters, or a lone surrogate escape, stay apart.
    for (const pattern of ["^(?:\\uD83D\\uDE00|\u{1F601})+$", "^(\\uD83D|a)+$", "^(?:\\uD83D\\uDE00\\uD83D\\uDE01)+$"]) {
        assert.equal(unsafeSchemaPattern(pattern), null, pattern);
    }
});
