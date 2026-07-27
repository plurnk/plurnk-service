// SPEC §tools — the registered executor catalogue is explicitly titled so its examples define
// the closed set of valid tags, above Requirements and omitted when the list is empty.

import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

test("registered executable tools render as a closed, titled catalogue above Requirements; omitted when empty", () => {
    // Parameterized tools body (empty ⇒ section omitted).
    const userSections = (tools: string) => [
        { name: "definition", slot: "user", header: null, content: "...plurnk.md...", tokens: 0 },
        { name: "tools", slot: "user", header: "Registered Executable Tools", content: tools, tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk Service Requirements", content: "Conclude with SEND.", tokens: 0 },
    ];
    const withTools = PacketWire.renderSlot(userSections("```plurnk\n<<EXEC[node]:console.log(42):EXEC\n```"), "user");
    assert.match(withTools, /<<EXEC\[node\]/, "the registered executable example renders");
    assert.match(withTools, /## Registered Executable Tools/, "the heading defines the examples as registered selectors");
    const toolsIdx = withTools.indexOf("<<EXEC[node]");
    const reqIdx = withTools.indexOf("## Plurnk Service Requirements");
    assert.ok(toolsIdx > -1 && reqIdx > toolsIdx, "tools render above Requirements");

    const noTools = PacketWire.renderSlot(userSections(""), "user");
    assert.doesNotMatch(noTools, /<<EXEC/, "no tools content rendered when nothing is enabled");
    assert.doesNotMatch(noTools, /Registered Executable Tools/, "an empty catalogue emits no heading");
});
