import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";

// -------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------

const provider = () => ({
    provider: "anthropic",
    family: "claude",
    model: "claude-opus-4-7",
    contextSize: 200000,
    currency: "USD",
});

const schemeReg = (name: string) => ({
    name,
    model_visible: true,
    category: "core",
    default_scope: "session" as const,
    default_channel: "body",
    writable_by: ["model" as const],
    volatile: false,
    handler: null,
});

const entry = () => ({
    id: 1,
    version: 0,
    scope: "agent" as const,
    session_id: null,
    scheme: "known",
    username: null, password: null, hostname: "philosophy", port: null,
    pathname: "/meaning", params: {},
    channels: {
        body: { content: "The meaning of life is 42.", mimetype: "text/markdown", tokens: 10 },
    },
    attributes: {},
    tags: ["philosophy"],
});

const logEntry = () => ({
    id: 1, version: 0,
    run_id: 1, loop_id: 1, turn_id: 1, action_index: 0,
    at: "2026-05-16T12:00:00Z",
    origin: "model" as const,
    op: "EDIT" as const,
    suffix: "",
    signal: ["philosophy"],
    target_scheme: "known",
    target_username: null, target_password: null, target_hostname: "philosophy", target_port: null,
    target_pathname: "/meaning", target_params: {}, target_fragment: null,
    lineMarker: null,
    tx: "<<EDIT[philosophy](known://philosophy/meaning):The meaning of life is 42:EDIT",
    mimetype_tx: "text/vnd.plurnk",
    rx: "",
    mimetype_rx: "text/plain",
    status_rx: 201,
    tokens: 32,
});

const packet = () => ({
    tokens: 100,
    system: {
        tokens: 60,
        system_definition: "# Plurnk\n\n...",
        persona: "# Persona\n\n...",
        index: [entry()],
        log: [logEntry()],
    },
    user: {
        tokens: 20,
        prompt: "What is the meaning of life?",
        telemetry: {
            budget: "| tokens remaining | 198500 |\n",
            errors: [],
        },
        system_requirements: "* answer concisely",
    },
    assistant: {
        tokens: 20,
        content: "<<SEND[200]:42:SEND",
        ops: [{
            op: "SEND",
            suffix: "",
            signal: 200,
            path: null,
            lineMarker: null,
            body: { raw: "42", json: 42 },
            position: { line: 1, column: 0 },
        }],
        reasoning: null,
    },
    assistantRaw: { id: "msg_abc", content: [{ type: "text", text: "<<SEND[200]:42:SEND" }] },
});

// -------------------------------------------------------------------------
// Loop
// -------------------------------------------------------------------------

test("Validator: Loop accepts status 102 (continuing)", () => {
    const { valid, errors } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 102, prompt: "Hello",
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Loop accepts status 200 (terminal ok)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 200, prompt: "Hello",
    });
    assert.equal(valid, true);
});

test("Validator: Loop accepts status 499 (terminal cancel)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 499, prompt: "Hello",
    });
    assert.equal(valid, true);
});

test("Validator: Loop rejects status outside {102, 200, 499}", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 1, status: 404, prompt: "Hello",
    });
    assert.equal(valid, false);
});

test("Validator: Loop rejects sequence 0 (must be 1-based)", () => {
    const { valid } = Validator.validateLoop({
        id: 1, version: 0, run_id: 1, sequence: 0, status: 102, prompt: "Hello",
    });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Run
// -------------------------------------------------------------------------

test("Validator: Run accepts trunk run (null parent_run_id)", () => {
    const { valid, errors } = Validator.validateRun({
        id: 1, version: 0, session_id: 1,
        created_at: "2026-05-16T12:00:00Z",
        parent_run_id: null,
        cost_pico: 0,
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Run accepts fork (numeric parent_run_id)", () => {
    const { valid } = Validator.validateRun({
        id: 2, version: 0, session_id: 1,
        created_at: "2026-05-16T13:00:00Z",
        parent_run_id: 1,
        cost_pico: 1500000,
    });
    assert.equal(valid, true);
});

test("Validator: Run rejects negative cost_pico", () => {
    const { valid } = Validator.validateRun({
        id: 1, version: 0, session_id: 1,
        created_at: "2026-05-16T12:00:00Z",
        parent_run_id: null,
        cost_pico: -1,
    });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Session
// -------------------------------------------------------------------------

test("Validator: Session accepts minimal row", () => {
    const { valid, errors } = Validator.validateSession({
        id: 1, version: 0,
        name: "claude-opus-4-7-1747800000",
        created_at: "2026-05-16T12:00:00Z",
        cost_pico: 0,
        scheme_registry_additions: [],
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Session accepts scheme_registry_additions via $ref", () => {
    const { valid, errors } = Validator.validateSession({
        id: 1, version: 0,
        name: "my-project",
        created_at: "2026-05-16T12:00:00Z",
        cost_pico: 0,
        scheme_registry_additions: [schemeReg("custom")],
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Session rejects empty name", () => {
    const { valid } = Validator.validateSession({
        id: 1, version: 0,
        name: "",
        created_at: "2026-05-16T12:00:00Z",
        cost_pico: 0,
        scheme_registry_additions: [],
    });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Agent
// -------------------------------------------------------------------------

test("Validator: Agent accepts singleton with provider + default schemes", () => {
    const { valid, errors } = Validator.validateAgent({
        version: 0,
        provider: provider(),
        scheme_registry: [schemeReg("plurnk"), schemeReg("known"), schemeReg("unknown")],
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Agent rejects missing provider", () => {
    const { valid } = Validator.validateAgent({
        version: 0,
        scheme_registry: [],
    });
    assert.equal(valid, false);
});

test("Validator: Agent rejects malformed provider currency", () => {
    const bad = { ...provider(), currency: "usd" };
    const { valid } = Validator.validateAgent({
        version: 0,
        provider: bad,
        scheme_registry: [],
    });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Packet — the composite shape
// -------------------------------------------------------------------------

test("Validator: Packet accepts well-formed end-to-end packet", () => {
    const { valid, errors } = Validator.validatePacket(packet());
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Packet accepts empty index/log arrays", () => {
    const p = packet();
    p.system.index = [];
    p.system.log = [];
    const { valid } = Validator.validatePacket(p);
    assert.equal(valid, true);
});

test("Validator: Packet accepts assistantRaw of any JSON shape", () => {
    const variants = [
        { ...packet(), assistantRaw: "string raw" },
        { ...packet(), assistantRaw: 42 },
        { ...packet(), assistantRaw: null },
        { ...packet(), assistantRaw: [1, 2, 3] },
    ];
    for (const v of variants) {
        const { valid } = Validator.validatePacket(v);
        assert.equal(valid, true);
    }
});

test("Validator: Packet rejects packet missing required section", () => {
    const p: any = packet();
    delete p.user;
    const { valid } = Validator.validatePacket(p);
    assert.equal(valid, false);
});

test("Validator: Packet rejects invalid Entry inside system.index[]", () => {
    const p: any = packet();
    p.system.index = [{ ...entry(), scope: "session", session_id: null }];
    const { valid } = Validator.validatePacket(p);
    assert.equal(valid, false);
});

test("Validator: Packet rejects invalid LogEntry inside system.log[]", () => {
    const p = packet();
    p.system.log = [{ ...logEntry(), status_rx: 999 }];
    const { valid } = Validator.validatePacket(p);
    assert.equal(valid, false);
});

test("Validator: Packet rejects invalid PlurnkStatement inside assistant.ops[]", () => {
    const p: any = packet();
    p.assistant.ops = [{
        op: "SEND",
        suffix: "",
        signal: ["should-be-number"],
        path: null,
        lineMarker: null,
        body: null,
        position: { line: 1, column: 0 },
    }];
    const { valid } = Validator.validatePacket(p);
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Turn — composes Packet
// -------------------------------------------------------------------------

test("Validator: Turn accepts end-to-end turn", () => {
    const { valid, errors } = Validator.validateTurn({
        id: 1, version: 0,
        loop_id: 1, sequence: 1,
        timestamp: "2026-05-16T12:00:00Z",
        status: 200,
        usage: { prompt: 1500, completion: 30, cached: 0, cost_pico: 1500000 },
        packet: packet(),
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Turn rejects invalid usage shape", () => {
    const { valid } = Validator.validateTurn({
        id: 1, version: 0,
        loop_id: 1, sequence: 1,
        timestamp: "2026-05-16T12:00:00Z",
        status: 200,
        usage: { prompt: -5, completion: 30, cached: 0, cost_pico: 1500000 },
        packet: packet(),
    });
    assert.equal(valid, false);
});

test("Validator: Turn rejects status outside HTTP range", () => {
    const { valid } = Validator.validateTurn({
        id: 1, version: 0,
        loop_id: 1, sequence: 1,
        timestamp: "2026-05-16T12:00:00Z",
        status: 1000,
        usage: { prompt: 1500, completion: 30, cached: 0, cost_pico: 1500000 },
        packet: packet(),
    });
    assert.equal(valid, false);
});
