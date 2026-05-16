import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";

// -------------------------------------------------------------------------
// Entry
// -------------------------------------------------------------------------

const minimalAgentEntry = () => ({
    id: 1,
    version: 0,
    scope: "agent" as const,
    session_id: null,
    scheme: "wiki",
    username: null,
    password: null,
    hostname: "Paris",
    port: null,
    pathname: "",
    params: {},
    channels: {
        body: { content: "Paris is the capital of France.", mimetype: "text/markdown", tokens: 9 },
    },
    attributes: {},
    tags: ["wikipedia", "geography"],
});

const minimalSessionEntry = () => ({
    ...minimalAgentEntry(),
    scope: "session" as const,
    session_id: 42,
});

test("Validator: Entry accepts minimal agent-scoped row", () => {
    const { valid, errors } = Validator.validateEntry(minimalAgentEntry());
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Entry accepts minimal session-scoped row", () => {
    const { valid, errors } = Validator.validateEntry(minimalSessionEntry());
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Entry accepts local path (scheme=null)", () => {
    const entry = { ...minimalAgentEntry(), scheme: null, hostname: null, pathname: "config/foo.xml" };
    const { valid, errors } = Validator.validateEntry(entry);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Entry rejects session scope with null session_id", () => {
    const entry = { ...minimalSessionEntry(), session_id: null };
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry rejects agent scope with non-null session_id", () => {
    const entry = { ...minimalAgentEntry(), session_id: 5 };
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry rejects missing channels field", () => {
    const entry: any = minimalAgentEntry();
    delete entry.channels;
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry rejects empty channels map", () => {
    const entry: any = minimalAgentEntry();
    entry.channels = {};
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry accepts multi-channel exec-style row", () => {
    const entry: any = {
        ...minimalAgentEntry(),
        scheme: "exec",
        hostname: "run-tests",
        channels: {
            stdout: { content: "ok\n", mimetype: "text/plain", tokens: 1 },
            stderr: { content: "warning: deprecated\n", mimetype: "text/plain", tokens: 3 },
        },
    };
    const { valid, errors } = Validator.validateEntry(entry);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Entry rejects channel name with uppercase", () => {
    const entry: any = minimalAgentEntry();
    entry.channels = { Body: { content: "x", mimetype: "text/plain", tokens: 0 } };
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry rejects channel with missing mimetype", () => {
    const entry: any = minimalAgentEntry();
    entry.channels = { body: { content: "x", tokens: 0 } };
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry rejects port > 65535", () => {
    const entry = { ...minimalAgentEntry(), port: 70000 };
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

test("Validator: Entry rejects extra property", () => {
    const entry: any = { ...minimalAgentEntry(), surprise: "field" };
    const { valid } = Validator.validateEntry(entry);
    assert.equal(valid, false);
});

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

// -------------------------------------------------------------------------
// ProviderDeclaration
// -------------------------------------------------------------------------

test("Validator: ProviderDeclaration accepts well-formed", () => {
    const { valid, errors } = Validator.validateProviderDeclaration({
        provider: "anthropic",
        family: "claude",
        model: "claude-opus-4-7",
        contextSize: 200000,
        currency: "USD",
    });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ProviderDeclaration accepts EUR currency", () => {
    const { valid } = Validator.validateProviderDeclaration({
        provider: "anthropic",
        family: "claude",
        model: "claude-opus-4-7",
        contextSize: 200000,
        currency: "EUR",
    });
    assert.equal(valid, true);
});

test("Validator: ProviderDeclaration rejects lowercase currency", () => {
    const { valid } = Validator.validateProviderDeclaration({
        provider: "anthropic",
        family: "claude",
        model: "claude-opus-4-7",
        contextSize: 200000,
        currency: "usd",
    });
    assert.equal(valid, false);
});

test("Validator: ProviderDeclaration rejects zero contextSize", () => {
    const { valid } = Validator.validateProviderDeclaration({
        provider: "anthropic",
        family: "claude",
        model: "claude-opus-4-7",
        contextSize: 0,
        currency: "USD",
    });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Visibility
// -------------------------------------------------------------------------

test("Validator: Visibility accepts indexed body channel", () => {
    const { valid } = Validator.validateVisibility({ entry_id: 1, channel: "body", indexed: true });
    assert.equal(valid, true);
});

test("Validator: Visibility accepts archived stderr channel", () => {
    const { valid } = Validator.validateVisibility({ entry_id: 1, channel: "stderr", indexed: false });
    assert.equal(valid, true);
});

test("Validator: Visibility rejects missing channel", () => {
    const { valid } = Validator.validateVisibility({ entry_id: 1, indexed: true });
    assert.equal(valid, false);
});

test("Validator: Visibility rejects uppercase channel name", () => {
    const { valid } = Validator.validateVisibility({ entry_id: 1, channel: "Body", indexed: true });
    assert.equal(valid, false);
});

test("Validator: Visibility rejects non-boolean indexed", () => {
    const { valid } = Validator.validateVisibility({ entry_id: 1, channel: "body", indexed: 1 });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// LogEntry
// -------------------------------------------------------------------------

const minimalLogEntry = () => ({
    id: 1,
    version: 0,
    run_id: 1,
    loop_id: 1,
    turn_id: 1,
    action_index: 0,
    at: "2026-05-16T12:00:00Z",
    origin: "model" as const,
    op: "EDIT" as const,
    suffix: "",
    signal: ["philosophy", "existentialism"],
    target_scheme: "known",
    target_username: null,
    target_password: null,
    target_hostname: "philosophy",
    target_port: null,
    target_pathname: "/meaning",
    target_params: {},
    target_fragment: null,
    lineMarker: null,
    tx: "<<EDIT[philosophy,existentialism](known://philosophy/meaning):The meaning of life is 42:EDIT",
    mimetype_tx: "text/x-plurnk",
    rx: "",
    mimetype_rx: "text/plain",
    status_rx: 201,
    tokens: 32,
});

test("Validator: LogEntry accepts minimal EDIT row", () => {
    const { valid, errors } = Validator.validateLogEntry(minimalLogEntry());
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: LogEntry accepts SEND with numeric signal", () => {
    const log = {
        ...minimalLogEntry(),
        op: "SEND" as const,
        signal: 200,
        target_scheme: null,
        target_hostname: null,
        target_pathname: null,
        target_params: null,
        tx: "<<SEND[200]:Paris:SEND",
        rx: "ok",
        status_rx: 200,
    };
    const { valid, errors } = Validator.validateLogEntry(log);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: LogEntry accepts EXEC with string signal", () => {
    const log = {
        ...minimalLogEntry(),
        op: "EXEC" as const,
        signal: "node",
        target_pathname: "/",
        tx: "<<EXEC[node](./):console.log(1):EXEC",
        rx: "1\n",
        status_rx: 200,
    };
    const { valid, errors } = Validator.validateLogEntry(log);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: LogEntry accepts lineMarker via cross-schema $ref", () => {
    const log = {
        ...minimalLogEntry(),
        op: "READ" as const,
        signal: [],
        lineMarker: { first: 1, last: 10 },
    };
    const { valid, errors } = Validator.validateLogEntry(log);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: LogEntry rejects SEND with array signal", () => {
    const log = {
        ...minimalLogEntry(),
        op: "SEND" as const,
        signal: ["should-be-number"],
    };
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry rejects EXEC with array signal", () => {
    const log = {
        ...minimalLogEntry(),
        op: "EXEC" as const,
        signal: ["node", "python"],
    };
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry rejects SEND with lineMarker", () => {
    const log = {
        ...minimalLogEntry(),
        op: "SEND" as const,
        signal: 200,
        lineMarker: { first: 1, last: null },
    };
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry rejects status_rx outside HTTP range", () => {
    const log = { ...minimalLogEntry(), status_rx: 42 };
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry rejects malformed at (not date-time)", () => {
    const log = { ...minimalLogEntry(), at: "yesterday" };
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry rejects unknown op", () => {
    const log: any = { ...minimalLogEntry(), op: "DROP" };
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry rejects missing mimetype_tx", () => {
    const log: any = minimalLogEntry();
    delete log.mimetype_tx;
    const { valid } = Validator.validateLogEntry(log);
    assert.equal(valid, false);
});

test("Validator: LogEntry accepts system origin with non-plurnk mimetype_tx", () => {
    const log = {
        ...minimalLogEntry(),
        origin: "system" as const,
        op: "EDIT" as const,
        signal: [],
        tx: JSON.stringify({ event: "scheme_registered", name: "wiki" }),
        mimetype_tx: "application/json",
    };
    const { valid, errors } = Validator.validateLogEntry(log);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: LogEntry accepts plugin origin with custom mimetype_tx", () => {
    const log = {
        ...minimalLogEntry(),
        origin: "plugin" as const,
        op: "EDIT" as const,
        signal: [],
        tx: "raw plugin event bytes",
        mimetype_tx: "application/octet-stream",
    };
    const { valid, errors } = Validator.validateLogEntry(log);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: Entry params via $ref to Params.json validates multi-value", () => {
    const entry = {
        id: 1,
        version: 0,
        scope: "agent" as const,
        session_id: null,
        scheme: "https",
        username: null,
        password: null,
        hostname: "example.com",
        port: null,
        pathname: "/api",
        params: { q: ["a", "b"], page: "2" },
        channels: {
            body: { content: "", mimetype: "application/json", tokens: 0 },
        },
        attributes: {},
        tags: [],
    };
    const { valid, errors } = Validator.validateEntry(entry);
    assert.equal(valid, true, JSON.stringify(errors));
});
