// Validates every TelemetryEvent kind plurnk-service emits against the
// envelope schema published in @plurnk/plurnk-grammar. Catches drift
// between our emissions and the cross-ecosystem contract.

import test from "node:test";
import { assertValidTelemetryEvent } from "./_telemetryEventSchema.ts";

test("schema: parse_error envelope (grammar source, content-offset position)", async () => {
    await assertValidTelemetryEvent({
        source: "grammar",
        kind: "parse_error",
        message: "invalid xpath: Unexpected character :",
        position: { type: "content-offset", line: 1, column: 0 },
        snippet: "1:\t<<READ(src/app.js):// TODO: add error handling:READ",
        parserSource: "visitor",
    }, "parse_error from grammar");
});

test("schema: action_failure envelope (engine-emitted with log-coordinate position)", async () => {
    // action_failure is engine-side mirror of a failed log entry. Plurnk-
    // service currently emits it without explicit source; once schemes
    // adopt the protocol (sibling-repo issues), source will be
    // `scheme:<name>`. Validate both shapes — the current shape requires
    // a synthetic source for envelope conformance, which the engine adds.
    await assertValidTelemetryEvent({
        source: "engine:rail",
        kind: "action_failure",
        coordinate: "1/1/2",
        op: "EDIT",
        status: 403,
        target: "log:///x",
        error: "writer 'model' denied on scheme 'log'",
        position: { type: "log-coordinate", coordinate: "log://1/1/2", op: "EDIT" },
    }, "action_failure with log-coordinate position");
});

test("schema: max_commands_exceeded envelope (engine:rail source, no position)", async () => {
    await assertValidTelemetryEvent({
        source: "engine:rail",
        kind: "max_commands_exceeded",
        emitted: 50,
        dropped: 30,
    }, "max_commands_exceeded from engine:rail");
});

test("schema: position can be omitted entirely", async () => {
    await assertValidTelemetryEvent({
        source: "grammar",
        kind: "parse_error",
        message: "lexer error",
    }, "parse_error without position");
});

test("schema: position can be explicit null", async () => {
    await assertValidTelemetryEvent({
        source: "engine:rail",
        kind: "max_commands_exceeded",
        emitted: 5,
        dropped: 2,
        position: null,
    }, "max_commands_exceeded with null position");
});

test("schema: rejects source that violates the namespace pattern", async () => {
    const { validateTelemetryEvent } = await import("./_telemetryEventSchema.ts");
    const errs = await validateTelemetryEvent({
        source: "Grammar",  // uppercase rejected
        kind: "parse_error",
    });
    if (errs.length === 0) throw new Error("expected validation failure for 'Grammar' source");
    if (!errs.some((e) => e.includes("violates pattern"))) {
        throw new Error(`expected pattern-violation error, got: ${errs.join(", ")}`);
    }
});

test("schema: rejects missing required kind", async () => {
    const { validateTelemetryEvent } = await import("./_telemetryEventSchema.ts");
    const errs = await validateTelemetryEvent({ source: "grammar" });
    if (errs.length === 0) throw new Error("expected validation failure for missing kind");
});

test("schema: rejects content-offset with negative line", async () => {
    const { validateTelemetryEvent } = await import("./_telemetryEventSchema.ts");
    const errs = await validateTelemetryEvent({
        source: "grammar",
        kind: "parse_error",
        position: { type: "content-offset", line: -1, column: 0 },
    });
    if (errs.length === 0) throw new Error("expected validation failure for negative line");
});

test("schema: rejects log-coordinate with empty coordinate string", async () => {
    const { validateTelemetryEvent } = await import("./_telemetryEventSchema.ts");
    const errs = await validateTelemetryEvent({
        source: "engine:rail",
        kind: "action_failure",
        position: { type: "log-coordinate", coordinate: "" },
    });
    if (errs.length === 0) throw new Error("expected validation failure for empty coordinate");
});

test("schema: additionalProperties at top level — kind-specific fields permitted", async () => {
    // The envelope allows extension at the kind-specific layer. snippet,
    // parserSource, emitted, dropped, coordinate, op, etc. all pass.
    await assertValidTelemetryEvent({
        source: "provider:openai",
        kind: "rate_limit",
        message: "throttled",
        retryAfter: 30,
        endpoint: "/v1/chat/completions",
    }, "future provider:openai rate_limit with arbitrary fields");
});
