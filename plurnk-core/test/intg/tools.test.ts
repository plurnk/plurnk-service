// SPEC {§tools} — the registered tool catalogue is explicitly titled so its table defines
// the closed set of valid tags and the section is omitted when the list is empty.

import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

test("registered tools render as a closed, titled contract table; omitted when empty", () => {
    // Parameterized tools body (empty ⇒ section omitted).
    const userSections = (tools: string) => [
        { name: "definition", slot: "user", header: null, content: "...plurnk.md...", weight: 0 },
        { name: "tools", slot: "user", header: "Registered Tools", content: tools, weight: 0 },
    ];
    const withTools = PacketWire.renderSlot(userSections("| `[executor]` | `(target)` | body | Invocation |\n| --- | --- | --- | --- |\n| `[node]` | script | JavaScript | `console.log(1);` |"), "user");
    assert.match(withTools, /\| `\[node\]` \| script \| JavaScript \|/, "the registered executable contract renders");
    assert.match(withTools, /## Registered Tools/, "the heading defines the table as registered selectors");
    const toolsIdx = withTools.indexOf("`[node]`");
    assert.ok(toolsIdx > withTools.indexOf("...plurnk.md..."), "tools render after the definition");

    const noTools = PacketWire.renderSlot(userSections(""), "user");
    assert.doesNotMatch(noTools, /`\[executor\]`/, "no tools content rendered when nothing is enabled");
    assert.doesNotMatch(noTools, /Registered Tools/, "an empty catalogue emits no heading");
});
