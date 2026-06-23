// SPEC §tools — the tools capability lines. Render-side: titleless (the examples flow on from
// plurnk.md, no `## Plurnk System Tools` header), above Requirements, omitted when the list is empty.

import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

test("[§tools-capability-sheet] tools capability lines render titleless (flowing from plurnk.md) above Requirements; omitted when empty", () => {
    // Parameterized tools body (empty ⇒ section omitted). The tools section is header-less now —
    // its lines follow the definition (plurnk.md) directly, no `## Plurnk System Tools` title.
    const userSections = (tools: string) => [
        { name: "definition", slot: "user", header: null, content: "...plurnk.md...", tokens: 0 },
        { name: "tools", slot: "user", header: null, content: tools, tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk System Requirements", content: "Conclude with SEND.", tokens: 0 },
    ];
    const withTools = PacketWire.renderSlot(userSections("- `<<PLAN:...:PLAN` — plan first."), "user");
    assert.match(withTools, /<<PLAN:\.\.\.:PLAN/, "the tools capability line renders");
    assert.doesNotMatch(withTools, /Plurnk System Tools/, "no Tools title — the lines flow on from plurnk.md");
    const toolsIdx = withTools.indexOf("<<PLAN");
    const reqIdx = withTools.indexOf("## Plurnk System Requirements");
    assert.ok(toolsIdx > -1 && reqIdx > toolsIdx, "tools render above Requirements");

    const noTools = PacketWire.renderSlot(userSections(""), "user");
    assert.doesNotMatch(noTools, /<<PLAN/, "no tools content rendered when nothing is enabled");
});
