// SPEC §tools — the # Plurnk System Tools capability sheet. Render-side
// placement (above Requirements) + omit-when-empty.

import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

test("[§tools-capability-sheet] # Plurnk System Tools renders above Requirements; omitted when the list is empty", () => {
    // Section list with a parameterized tools body (empty body ⇒ section omitted).
    const userSections = (tools: string) => [
        { name: "prompt", slot: "user", header: "Plurnk System User Prompt", content: "go", tokens: 0 },
        { name: "tools", slot: "user", header: "Plurnk System Tools", content: tools, tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk System Requirements", content: "Conclude with SEND.", tokens: 0 },
    ];
    const withTools = PacketWire.renderSlot(userSections("- `<<PLAN:...:PLAN` — plan first."), "user");
    assert.match(withTools, /# Plurnk System Tools\n\n- `<<PLAN/, "Tools section carries its capability line");
    const toolsIdx = withTools.indexOf("# Plurnk System Tools");
    const reqIdx = withTools.indexOf("# Plurnk System Requirements");
    assert.ok(toolsIdx > -1 && reqIdx > toolsIdx, "Tools renders above Requirements");

    const noTools = PacketWire.renderSlot(userSections(""), "user");
    assert.doesNotMatch(noTools, /# Plurnk System Tools/, "no Tools header when nothing is enabled");
});
