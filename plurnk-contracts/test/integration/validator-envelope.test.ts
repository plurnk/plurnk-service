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
    handler: "@example/plurnk-schemes-wiki",
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
