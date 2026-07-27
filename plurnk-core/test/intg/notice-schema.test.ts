// Validates every Notice kind plurnk-service emits against the
// envelope schema published in @plurnk/plurnk-grammar. Catches drift
// between our emissions and the cross-ecosystem contract.

import test from "node:test";
import { assertValidNotice } from "./_noticeSchema.ts";

test("schema: grammar_unenforced notice carries a content-offset position", async () => {
    await assertValidNotice({
        source: "provider:local",
        kind: "grammar_unenforced",
        level: "warn",
        message: "transported grammar diverged from returned content",
        position: { type: "content-offset", line: 1, column: 0 },
    }, "grammar_unenforced from provider");
});

test("schema: search_progress notice permits kind-specific fields and a log coordinate", async () => {
    await assertValidNotice({
        source: "exec:search",
        kind: "search_progress",
        level: "info",
        completed: 5,
        total: 10,
        percent: 50,
        position: { type: "log-coordinate", coordinate: "log:///1/1/2", op: "EXEC" },
    }, "search_progress with log-coordinate position");
});

test("schema: position can be omitted entirely", async () => {
    await assertValidNotice({
        source: "engine:turn",
        kind: "turn_awaiting_model",
        level: "info",
        message: "awaiting model response",
    }, "turn heartbeat without position");
});

test("schema: position can be explicit null", async () => {
    await assertValidNotice({
        source: "tokenizer",
        kind: "tokenizer_unavailable",
        level: "warn",
        position: null,
    }, "tokenizer degradation with null position");
});

test("schema: rejects source that violates the namespace pattern", async () => {
    const { validateNotice } = await import("./_noticeSchema.ts");
    const errs = await validateNotice({
        source: "Grammar",  // uppercase rejected
        kind: "turn_awaiting_model",
        level: "info",
    });
    if (errs.length === 0) throw new Error("expected validation failure for 'Grammar' source");
    if (!errs.some((e) => e.includes("violates pattern"))) {
        throw new Error(`expected pattern-violation error, got: ${errs.join(", ")}`);
    }
});

test("schema: rejects missing required kind", async () => {
    const { validateNotice } = await import("./_noticeSchema.ts");
    const errs = await validateNotice({ source: "engine:turn", level: "info" });
    if (errs.length === 0) throw new Error("expected validation failure for missing kind");
});

test("schema: rejects missing required level", async () => {
    const { validateNotice } = await import("./_noticeSchema.ts");
    const errs = await validateNotice({ source: "engine:turn", kind: "turn_awaiting_model" });
    if (errs.length === 0) throw new Error("expected validation failure for missing level");
});

test("schema: rejects content-offset with negative line", async () => {
    const { validateNotice } = await import("./_noticeSchema.ts");
    const errs = await validateNotice({
        source: "provider:local",
        kind: "grammar_unenforced",
        level: "warn",
        position: { type: "content-offset", line: -1, column: 0 },
    });
    if (errs.length === 0) throw new Error("expected validation failure for negative line");
});

test("schema: rejects log-coordinate with empty coordinate string", async () => {
    const { validateNotice } = await import("./_noticeSchema.ts");
    const errs = await validateNotice({
        source: "exec:search",
        kind: "search_progress",
        level: "info",
        position: { type: "log-coordinate", coordinate: "" },
    });
    if (errs.length === 0) throw new Error("expected validation failure for empty coordinate");
});

test("schema: additionalProperties at top level permit producer-specific fields", async () => {
    await assertValidNotice({
        source: "provider:openai",
        kind: "grammar_unenforced",
        level: "warn",
        message: "transported grammar diverged from returned content",
        railsVerdict: "reject",
        model: "example",
    }, "provider observation with arbitrary fields");
});
