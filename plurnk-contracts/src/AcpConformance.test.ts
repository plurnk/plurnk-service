import test from "node:test";
import assert from "node:assert/strict";
import conformanceKit from "../conformance/acp-v2.json" with { type: "json" };
import { acpConformanceReport, Validator } from "./index.ts";

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

test("{§acp-client-conformance}: every installed name requires an evidence-bearing disposition", () => {
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

test("{§acp-conformance-kit}: the contracts-owned specimen document is valid", () => {
    const kit = Validator.assertAcpConformanceKit(conformanceKit);
    assert.deepEqual(
        kit.transport.map(({ name }) => name),
        ["comments-crlf-split-multiline", "split-frame-and-eof-dispatch", "malformed-json", "cr-only-lines"],
    );
    assert.ok(kit.lifecycles.some(({ name }) => name === "interaction-interrupt"));
    assert.ok(kit.lifecycles.some(({ name }) => name === "dead-stream"));
});

test("{§acp-action-schema-enforcement}: dynamic schemas resolve contracts-owned references", () => {
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
