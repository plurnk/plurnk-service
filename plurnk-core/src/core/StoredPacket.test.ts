import test from "node:test";
import assert from "node:assert/strict";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";

const request = (): RequestPacket => ({
    weight: 3,
    sections: [{ name: "prompt", slot: "user", header: null, content: "hello", weight: 3 }],
    attributions: ["creator:ada", "topic:search"],
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
    assert.equal(packet.weight, 3);
    assert.equal(packet.assistantRaw, null);
    assert.equal(StoredPacket.isAdmitted(packet), true);
});

test("StoredPacket: attribution evidence is a canonical opaque tag set", () => {
    assert.throws(
        () => StoredPacket.assert({ ...request(), attributions: ["topic:search", "creator:ada"] }),
        /packet\.attributions must be deduplicated and sorted/,
    );
    assert.throws(
        () => StoredPacket.assert({ ...request(), attributions: ["creator:ada", "creator:ada"] }),
        /packet\.attributions must be deduplicated and sorted/,
    );
    assert.throws(
        () => StoredPacket.assert({ ...request(), attributions: [""] }),
        /packet\.attributions\[0\] must be a non-empty string/,
    );
});

test("StoredPacket: malformed durable shapes fail with their causal location", () => {
    assert.throws(() => StoredPacket.parse("{"), /contains invalid JSON/);
    assert.throws(() => StoredPacket.parse("{}", "turn 7"), /turn 7 has an invalid packet shape/);
    assert.throws(
        () => StoredPacket.assert({ ...request(), sections: [{ ...request().sections[0], weight: -1 }] }),
        /sections\[0\]\.weight must be a non-negative safe integer/,
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
