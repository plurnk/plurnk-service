import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";

// -------------------------------------------------------------------------
// SchemeRegistration
// -------------------------------------------------------------------------

const minimalSchemeReg = () => ({
    name: "wiki",
    model_visible: true,
    category: "external",
    default_scope: "workspace" as const,
    default_channel: "body",
    writable_by: ["model" as const],
    volatile: false,
    handler: "plurnk://handlers/wiki",
});

test("Validator: SchemeRegistration accepts minimal row", () => {
    const { valid, errors } = Validator.validateSchemeRegistration(minimalSchemeReg());
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration accepts worker-scoped default", () => {
    const { valid, errors } = Validator.validateSchemeRegistration({ ...minimalSchemeReg(), name: "worker", default_scope: "worker" });
    assert.equal(valid, true, JSON.stringify(errors));
});

// Retired words retire EMPTY (#486 law 2): the old scope nouns never come back with
// shifted referents — a live word with a flipped meaning poisons every existing log and doc.
test("Validator: SchemeRegistration rejects retired scopes — agent, run, session", () => {
    for (const scope of ["agent", "run", "session"]) {
        const { valid } = Validator.validateSchemeRegistration({ ...minimalSchemeReg(), default_scope: scope as never });
        assert.equal(valid, false, `retired scope "${scope}" must not validate`);
    }
});

test("Validator: SchemeRegistration accepts null handler (core scheme)", () => {
    const reg = { ...minimalSchemeReg(), name: "known", handler: null };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, true);
});

test("Validator: SchemeRegistration accepts multi-tier writable_by", () => {
    const reg = { ...minimalSchemeReg(), writable_by: ["model", "system", "plugin"] };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, true);
});

test("Validator: SchemeRegistration rejects invalid scheme name", () => {
    const reg = { ...minimalSchemeReg(), name: "BadScheme" };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, false);
});

test("Validator: SchemeRegistration rejects duplicate writable_by tier", () => {
    const reg = { ...minimalSchemeReg(), writable_by: ["model", "model"] };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, false);
});

test("Validator: SchemeRegistration rejects unknown writable_by tier", () => {
    const reg = { ...minimalSchemeReg(), writable_by: ["admin"] };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, false);
});

test("Validator: SchemeRegistration accepts omitted channel_orientations (defaults apply)", () => {
    const reg = minimalSchemeReg();
    const { valid, errors } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration accepts empty channel_orientations object", () => {
    const reg = { ...minimalSchemeReg(), channel_orientations: {} };
    const { valid, errors } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration accepts channel_orientations with tail channels (exec-style)", () => {
    const reg = {
        ...minimalSchemeReg(),
        name: "exec",
        channel_orientations: { stdout: "tail", stderr: "tail" },
    };
    const { valid, errors } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration accepts mixed head/tail orientations", () => {
    const reg = {
        ...minimalSchemeReg(),
        channel_orientations: { body: "head", events: "tail" },
    };
    const { valid, errors } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration rejects unknown orientation value", () => {
    const reg = {
        ...minimalSchemeReg(),
        channel_orientations: { body: "middle" },
    };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, false);
});

test("Validator: SchemeRegistration rejects channel_orientations key with uppercase", () => {
    const reg = {
        ...minimalSchemeReg(),
        channel_orientations: { Body: "head" },
    };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, false);
});

test("Validator: SchemeRegistration rejects nested object for channel_orientations value", () => {
    const reg = {
        ...minimalSchemeReg(),
        channel_orientations: { body: { orientation: "head" } },
    };
    const { valid } = Validator.validateSchemeRegistration(reg);
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// ProviderDeclaration
// -------------------------------------------------------------------------

test("Validator: ProviderDeclaration accepts well-formed", () => {
    const { valid, errors } = Validator.validateProviderDeclaration({
        provider: "local",
        family: "gemma",
        model: "gemma3-12b",
        contextSize: 8192,
        currency: "USD",
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ProviderDeclaration accepts EUR currency", () => {
    const { valid } = Validator.validateProviderDeclaration({
        provider: "local",
        family: "gemma",
        model: "gemma3-12b",
        contextSize: 8192,
        currency: "EUR",
    });
    assert.equal(valid, true);
});

test("Validator: ProviderDeclaration rejects lowercase currency", () => {
    const { valid } = Validator.validateProviderDeclaration({
        provider: "local",
        family: "gemma",
        model: "gemma3-12b",
        contextSize: 8192,
        currency: "usd",
    });
    assert.equal(valid, false);
});

test("Validator: ProviderDeclaration rejects zero contextSize", () => {
    const { valid } = Validator.validateProviderDeclaration({
        provider: "local",
        family: "gemma",
        model: "gemma3-12b",
        contextSize: 0,
        currency: "USD",
    });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Notice
// -------------------------------------------------------------------------

test("Validator: Notice accepts grammar enforcement observation with content-offset position", () => {
    const ev = {
        source: "provider:local",
        kind: "grammar_unenforced",
        level: "warn",
        message: "transported grammar diverged from the returned content",
        position: { type: "content-offset", line: 3, column: 12 },
    };
    const { valid, errors } = Validator.validateNotice(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Notice accepts derivation progress with kind-specific fields", () => {
    const ev = {
        source: "engine:derivation",
        kind: "embed_progress",
        level: "info",
        completed: 2,
        total: 3,
        percent: 66,
    };
    const { valid, errors } = Validator.validateNotice(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Notice accepts search progress with a log-coordinate", () => {
    const ev = {
        source: "exec:search",
        kind: "search_progress",
        level: "info",
        message: "acquiring search results: 50%",
        position: { type: "log-coordinate", coordinate: "log:///1/2/3", op: "EXEC" },
    };
    const { valid, errors } = Validator.validateNotice(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Notice accepts a turn-lifecycle heartbeat with no message", () => {
    const ev = { source: "engine:turn", kind: "turn_awaiting_model", level: "info" };
    const { valid, errors } = Validator.validateNotice(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Notice rejects missing source", () => {
    const ev: any = { kind: "parse_error", level: "error" };
    const { valid } = Validator.validateNotice(ev);
    assert.equal(valid, false);
});

test("Validator: Notice rejects missing kind", () => {
    const ev: any = { source: "grammar", level: "error" };
    const { valid } = Validator.validateNotice(ev);
    assert.equal(valid, false);
});

test("Validator: Notice rejects missing level", () => {
    const ev: any = { source: "grammar", kind: "parse_error" };
    const { valid } = Validator.validateNotice(ev);
    assert.equal(valid, false);
});

test("Validator: Notice rejects level outside the error|warn|info enum", () => {
    const ev = { source: "grammar", kind: "parse_error", level: "debug" };
    const { valid } = Validator.validateNotice(ev);
    assert.equal(valid, false);
});

test("Validator: Notice rejects malformed source pattern", () => {
    const ev = { source: "Grammar:Bad", kind: "x", level: "error" };
    const { valid } = Validator.validateNotice(ev);
    assert.equal(valid, false);
});

test("Validator: Notice rejects unknown position type", () => {
    const ev = {
        source: "grammar",
        kind: "parse_error",
        level: "error",
        position: { type: "byte-offset", offset: 42 },
    };
    const { valid } = Validator.validateNotice(ev);
    assert.equal(valid, false);
});

// RFC 9457 operation failures

test("Validator: ProblemDetails accepts a typed operation failure", () => {
    const problem = {
        type: "https://problems.plurnk.dev/schemes/file/not-found",
        title: "Not found",
        status: 404,
        detail: "No file exists at file:///missing.md.",
        instance: "log:///1/2/3/READ",
    };
    const { valid, errors } = Validator.validateProblemDetails(problem);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ProblemDetails requires actionable RFC 9457 fields", () => {
    assert.equal(Validator.validateProblemDetails({ status: 404 }).valid, false);
    assert.equal(Validator.validateProblemDetails({
        type: "not-an-absolute-uri",
        title: "Not found",
        status: 404,
        detail: "Missing.",
    }).valid, false);
});

test("Validator: OperationResult discriminates success from failure", () => {
    assert.equal(Validator.validateOperationResult({ status: 200, content: "ok" }).valid, true);
    assert.equal(Validator.validateOperationResult({
        status: 404,
        problem: {
            type: "https://problems.plurnk.dev/schemes/file/not-found",
            title: "Not found",
            status: 404,
            detail: "Missing.",
        },
    }).valid, true);
    assert.equal(Validator.validateOperationResult({ status: 404 }).valid, false);
    assert.equal(Validator.validateOperationResult({
        status: 200,
        problem: {
            type: "https://problems.plurnk.dev/internal/contradiction",
            title: "Contradiction",
            status: 500,
            detail: "A success cannot carry a problem.",
        },
    }).valid, false);
    assert.equal(Validator.validateOperationResult({ status: 404, error: "legacy" }).valid, false);
});
