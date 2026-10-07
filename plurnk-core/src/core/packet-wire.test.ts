import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";
import type { RequestPacket } from "./StoredPacket.ts";

test("{§packet-wire-envelope} {§previous-emission}: slots reach two roles unchanged, with the whole previous program last", () => {
    const content = "```EDIT (a.md)\nFull replacement.\n```\n\n```NOTE\nA remembered observation.\n```";
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: "### log:///1/2/1/emission · 24", weight: 0 },
        { name: "recap", slot: "user", header: "Recap", content: "Current context", weight: 0 },
        { name: "previous-emission", slot: "user", header: "Previous Emission", content, weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: `## Log\n\n### log:///1/2/1/emission · 24\n\n## Recap\n\nCurrent context\n\n## Previous Emission\n\n${content}` },
    ]);
});

test("{§previous-emission}: an empty stored section emits no heading, placeholder or assistant message", () => {
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 0 },
        { name: "previous-emission", slot: "user", header: "Previous Emission", content: "", weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: "## Open Messages\n[]" },
    ]);
});
