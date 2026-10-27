import test, { describe } from "node:test";
import assert from "node:assert/strict";
import conformanceKit from "../conformance/acp-v2.json" with { type: "json" };
import { acpConformanceReport, Validator, requestOrigin } from "./index.ts";
import schema from "../schema/ApplicationOperationEvent.json" with { type: "json" };
import { UNKNOWN_POSITION } from "./types.ts";
import { excerptOf } from "./Excerpt.ts";
import { lifecycleOfLoopStatus, selectSessionLoop } from "./LoopLifecycle.ts";

describe("AcpConformance", () => {
const discovery = {
    schemaVersion: 1,
    actions: {
        ping: {
            scope: "daemon",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: { type: "object", additionalProperties: false },
        },
    },
    notifications: {
        "notice/event": {
            payloadSchema: { type: "object", additionalProperties: true },
        },
    },
    display: [],
} as const;

const actionDisposition = {
    posture: "generic",
    dimensions: ["projection", "success", "failure"],
    evidence: ["transport contract test"],
} as const;
const notificationDisposition = {
    posture: "generic",
    dimensions: ["framing", "projection"],
    evidence: ["transport contract test"],
} as const;
const conformance = {
    schemaVersion: 1,
    client: "example-client",
    actions: { ping: actionDisposition },
    notifications: { "notice/event": notificationDisposition },
} as const;

test("{§contract-representations}: every installed name requires an evidence-bearing disposition", () => {
    assert.equal(
        Validator.assertAcpClientConformance(discovery, conformance).client,
        "example-client",
    );
    assert.throws(
        () => Validator.assertAcpClientConformance(discovery, {
            ...conformance,
            actions: {},
        }),
        /missing action 'ping'/,
    );
    assert.deepEqual(acpConformanceReport(discovery, conformance), [
        {
            kind: "action",
            name: "ping",
            posture: "generic",
            dimensions: ["projection", "success", "failure"],
            evidence: ["transport contract test"],
        },
        {
            kind: "notification",
            name: "notice/event",
            posture: "generic",
            dimensions: ["framing", "projection"],
            evidence: ["transport contract test"],
        },
    ]);
});

test("{§contract-representations}: the contracts-owned specimen document is valid", () => {
    const kit = Validator.assertAcpConformanceKit(conformanceKit);
    assert.deepEqual(
        kit.transport.map(({ name }) => name),
        ["comments-crlf-split-multiline", "split-frame-and-eof-dispatch", "malformed-json", "cr-only-lines"],
    );
    assert.ok(kit.lifecycles.some(({ name }) => name === "interaction-interrupt"));
    assert.ok(kit.lifecycles.some(({ name }) => name === "dead-stream"));
});

test("{§contract-representations}: dynamic schemas resolve contracts-owned references", () => {
    assert.doesNotThrow(() => Validator.assertJsonSchemaInstance(
        "MCP extension input",
        {
            type: "object",
            required: ["oauth"],
            additionalProperties: false,
            properties: {
                oauth: { $ref: "https://schemas.plurnk.xyz/v0/McpOAuth.json" },
            },
        },
        { oauth: { type: "oauth", redirectUrl: "http://127.0.0.1:8765/callback" } },
    ));
});
});

describe("ApplicationOperationEvent", () => {
test("{§notifications} dispatch observations preserve the phase/result boundary", () => {
    const start = {
        sessionId: 7, loopId: 9, turnId: 11, sequence: 2, origin: "model", projectRoot: null, phase: "started",
        statement: { op: "READ", target: { kind: "local", raw: "README.md" },
            aside: null, metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION },
    };
    const validate = (value: unknown) => Validator.validateJsonSchemaInstance(schema, value);
    for (const value of [start, { ...start, phase: "settled", result: { status: 200, content: "read body" } }]) {
        const result = validate(value);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    }
    for (const value of [
        { ...start, result: { status: 200 } },
        { ...start, phase: "settled" },
        { ...start, phase: "finished" },
        { ...start, sequence: 0 },
        { ...start, origin: "guessed-client" },
    ]) assert.equal(validate(value).valid, false, JSON.stringify(value));
});
});

describe("Excerpt", () => {
test("{§application-session-observation} the excerpt is the first line holding anything but blanks, cut whole characters, blanks trimmed from its end", () => {
    const cases: ReadonlyArray<readonly [string, number, string, boolean, string]> = [
        ["Fits.", 10, "Fits.", false, "a short message is its own excerpt"],
        ["Fits.\n   \n", 10, "Fits.", false, "trailing blank lines continue nothing"],
        ["\n \n  No, you did it wrong!  \r\nHere is why.", 10, "No, you di", true, "leading blank lines and spaces are skipped"],
        ["Check the tests, all of them.", 10, "Check the", true, "a cut that lands after a space keeps no trailing blank"],
        ["Line one\r\nLine two", 20, "Line one", true, "a carriage return ends no excerpt's words"],
        ["a\tb", 10, "a\tb", false, "a tab inside the line stays"],
        ["😀".repeat(12), 10, "😀".repeat(10), true, "a character is never cut in two"],
        ["", 10, "", false, "an empty message"],
        [" \n\t\r\n", 10, "", false, "a message of blanks alone"],
        [" x", 10, " x", false, "a no-break space is not a blank"],
        ["first\n\nsecond", 3, "fir", true, "a cut first line continues"],
    ];
    for (const [text, chars, excerpt, continued, why] of cases) {
        assert.deepEqual(excerptOf(text, chars), { excerpt, continued }, why);
    }
    const long = `${"x".repeat(1_000_000)}\nmore`;
    assert.deepEqual(excerptOf(long, 240), { excerpt: "x".repeat(240), continued: true }, "a long line costs its excerpt, not its length");
});
});

describe("HttpOrigin", () => {
test("{§http-host} a request's origin is the address its Host names, over http, else the listener's own", () => {
    const listener = { host: "0.0.0.0", port: 1066 };
    for (const [named, origin] of [
        ["192.168.1.88:1066", "http://192.168.1.88:1066"],
        ["desktop.lan:1066", "http://desktop.lan:1066"],
        ["[fe80::1]:1066", "http://[fe80::1]:1066"],
        ["localhost", "http://localhost"],
    ] as const) assert.equal(requestOrigin({ headers: { host: named } }, listener), origin, named);
    assert.equal(requestOrigin({ headers: {} }, listener), "http://0.0.0.0:1066", "a request that names no address is answered at the listener's");
    assert.equal(requestOrigin({ headers: {} }, { host: "::1", port: 1066 }), "http://[::1]:1066");
});
});

describe("LoopLifecycle", () => {
test("{§application-session-observation} one projection from loop status to the shared lifecycle words", () => {
    assert.equal(lifecycleOfLoopStatus(null), "idle");
    assert.equal(lifecycleOfLoopStatus(undefined), "idle");
    assert.equal(lifecycleOfLoopStatus(100), "queued");
    assert.equal(lifecycleOfLoopStatus(102), "running");
    assert.equal(lifecycleOfLoopStatus(202), "parked");
    for (const concluded of [200, 204]) assert.equal(lifecycleOfLoopStatus(concluded), "completed", `a loop that concluded ${concluded}`);
    assert.equal(lifecycleOfLoopStatus(499), "cancelled", "a loop stopped without failing");
    for (const terminal of [413, 429, 500, 504, 508]) assert.equal(lifecycleOfLoopStatus(terminal), "failed", String(terminal));
});

test("{§application-session-observation}: live work outranks newer terminal history", () => {
    const loop = (sequence: number, status: number, terminatedAt: string | null = null) => ({ sequence, status, terminatedAt });
    const running = loop(2, 102);
    const parked = loop(1, 202);
    const queued = loop(3, 100);
    const completed = loop(4, 200, "2026-09-16T01:00:00.000Z");
    const failed = loop(5, 500, "2026-09-16T00:00:00.000Z");
    assert.equal(selectSessionLoop([parked, running, queued, completed, failed]), running);
    assert.equal(selectSessionLoop([completed, queued, parked]), parked);
    assert.equal(selectSessionLoop([completed, queued]), queued);
    assert.equal(selectSessionLoop([failed, completed]), completed, "latest settlement, not greatest sequence");
    assert.equal(selectSessionLoop([loop(6, 100), queued]), queued, "oldest obligation within the same live state");
    assert.equal(selectSessionLoop([]), null);
});
});
