import test from "node:test";
import assert from "node:assert/strict";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";

const request = (): RequestPacket => ({
    tokens: 3,
    sections: [{ name: "prompt", slot: "user", header: null, content: "hello", tokens: 3 }],
});

test("StoredPacket: NULL is the singular no-request representation", () => {
    assert.equal(StoredPacket.parse(null), null);
});

test("StoredPacket: request-only round trip preserves the exact measured request", () => {
    const packet = request();
    assert.deepEqual(StoredPacket.parse(StoredPacket.stringify(packet)), packet);
});

test("StoredPacket: admission extends the request without changing its weight", () => {
    const packet = StoredPacket.admit(request(), { content: "response", ops: [], reasoning: null }, undefined);
    assert.equal(packet.tokens, 3);
    assert.equal(packet.assistantRaw, null);
    assert.equal(StoredPacket.isAdmitted(packet), true);
});

test("StoredPacket: malformed durable shapes fail with their causal location", () => {
    assert.throws(() => StoredPacket.parse("{"), /contains invalid JSON/);
    assert.throws(() => StoredPacket.parse("{}", "turn 7"), /turn 7 has an invalid packet shape/);
    assert.throws(
        () => StoredPacket.assert({ ...request(), sections: [{ ...request().sections[0], tokens: -1 }] }),
        /sections\[0\]\.tokens must be a non-negative safe integer/,
    );
    assert.throws(
        () => StoredPacket.assert({ ...request(), assistant: { content: "", ops: [], reasoning: null } }),
        /assistant and packet\.assistantRaw must be present together/,
    );
    assert.throws(
        () => StoredPacket.assert({
            ...request(),
            assistant: { content: "", ops: [{}], reasoning: null },
            assistantRaw: null,
        }),
        /ops\[0\] is not a PlurnkStatement/,
    );
});
