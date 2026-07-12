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
    default_scope: "session" as const,
    default_channel: "body",
    writable_by: ["model" as const],
    volatile: false,
    handler: "plurnk://handlers/wiki",
});

test("Validator: SchemeRegistration accepts minimal row", () => {
    const { valid, errors } = Validator.validateSchemeRegistration(minimalSchemeReg());
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration accepts run-scoped default", () => {
    const { valid, errors } = Validator.validateSchemeRegistration({ ...minimalSchemeReg(), name: "run", default_scope: "run" });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: SchemeRegistration rejects retired agent scope", () => {
    const { valid } = Validator.validateSchemeRegistration({ ...minimalSchemeReg(), default_scope: "agent" });
    assert.equal(valid, false);
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
// TelemetryEvent
// -------------------------------------------------------------------------

test("Validator: TelemetryEvent accepts grammar parse_error with content-offset position", () => {
    const ev = {
        source: "grammar",
        kind: "parse_error:lexer",
        level: "error",
        message: "unexpected `<<` in target",
        position: { type: "content-offset", line: 3, column: 12 },
    };
    const { valid, errors } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: TelemetryEvent accepts engine:rail strike with kind-specific fields", () => {
    const ev = {
        source: "engine:rail",
        kind: "strike",
        level: "warn",
        streak: 2,
        maxStrikes: 3,
        reason: "no_ops",
    };
    const { valid, errors } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: TelemetryEvent accepts scheme:wiki dispatch_failure with log-coordinate", () => {
    const ev = {
        source: "scheme:wiki",
        kind: "dispatch_failure",
        level: "error",
        message: "no such entry",
        position: { type: "log-coordinate", coordinate: "log://1/2/3", op: "READ" },
    };
    const { valid, errors } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: TelemetryEvent accepts engine:rail sudden_death with no message", () => {
    const ev = { source: "engine:rail", kind: "sudden_death", level: "error" };
    const { valid, errors } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: TelemetryEvent rejects missing source", () => {
    const ev: any = { kind: "parse_error", level: "error" };
    const { valid } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, false);
});

test("Validator: TelemetryEvent rejects missing kind", () => {
    const ev: any = { source: "grammar", level: "error" };
    const { valid } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, false);
});

test("Validator: TelemetryEvent rejects missing level", () => {
    const ev: any = { source: "grammar", kind: "parse_error" };
    const { valid } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, false);
});

test("Validator: TelemetryEvent rejects level outside the error|warn|info enum", () => {
    const ev = { source: "grammar", kind: "parse_error", level: "debug" };
    const { valid } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, false);
});

test("Validator: TelemetryEvent rejects malformed source pattern", () => {
    const ev = { source: "Grammar:Bad", kind: "x", level: "error" };
    const { valid } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, false);
});

test("Validator: TelemetryEvent rejects unknown position type", () => {
    const ev = {
        source: "grammar",
        kind: "parse_error",
        level: "error",
        position: { type: "byte-offset", offset: 42 },
    };
    const { valid } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, false);
});

test("Validator: PlurnkParseError.toTelemetryEvent() validates", async () => {
    const { default: PlurnkParseError } = await import("../../src/PlurnkParseError.ts");
    const err = new PlurnkParseError(5, 12, "lexer", "stray token");
    const ev = err.toTelemetryEvent();
    const { valid, errors } = Validator.validateTelemetryEvent(ev);
    assert.equal(valid, true, JSON.stringify(errors));
    assert.equal(ev.source, "grammar");
    assert.equal(ev.kind, "parse_error:lexer");
    assert.deepEqual(ev.position, { type: "content-offset", line: 5, column: 12 });
});
