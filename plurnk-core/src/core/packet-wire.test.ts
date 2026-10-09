import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";
import type { RequestPacket } from "./StoredPacket.ts";

test("{§packet-wire-envelope}: retained user-role evidence keeps its original envelope", () => {
    const content = "```EDIT (a.md)\nFull replacement.\n```\n\n```NOTE\nA remembered observation.\n```";
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: "### log:///1/2/1/emission · 24", weight: 0 },
        { name: "recap", slot: "user", header: "Recap", content: "Current context", weight: 0 },
        { name: "emission-history", slot: "user", header: "Previous Emission", content, weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: `## Log\n\n### log:///1/2/1/emission · 24\n\n## Recap\n\nCurrent context\n\n## Previous Emission\n\n${content}` },
    ]);
});

test("{§packet-wire-envelope}: historical whole-log and assistant-tail sections keep their recorded placement", () => {
    const content = "````EDIT (a.md)\nFull replacement.\n```NOTE\nNested example.\n```\n````\n\n```NOTE\nMemory.\n```";
    const log = "### log:///1/2/1/READ · 24\n1: ## Worker\n2: ## Previous Emission";
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: log, weight: 0 },
        { name: "emission-history", slot: "assistant", header: null, content, weight: 0 },
        { name: "worker", slot: "user", header: "Worker", content: '{"turn":3}', weight: 0 },
        { name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: `## Log\n\n${log}` },
        { role: "assistant", content },
        { role: "user", content: '## Worker\n{"turn":3}\n\n## Open Messages\n[]' },
    ], "roles and boundaries come from sections, never headings inside source text");
});

test("{§emission-history}: an empty stored section emits no heading, placeholder or assistant message", () => {
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: "retained log", weight: 0 },
        { name: "emission-history", slot: "assistant", header: null, content: "", weight: 0 },
        { name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: "## Log\n\nretained log\n\n## Open Messages\n[]" },
    ]);
});
