import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPlaceholders, schemaVersion } from "./AgentPlugins.ts";

test("{§agent-plugins-expansion} both placeholders expand at every occurrence", () => {
    assert.equal(
        expandPlaceholders("${PLUGIN_ROOT}/bin:${PLUGIN_DATA}/cache:${PLUGIN_ROOT}", { root: "/plugins/p", data: "/data/p" }),
        "/plugins/p/bin:/data/p/cache:/plugins/p",
    );
});

test("{§agent-plugins-expansion} text a replacement introduces is never scanned again", () => {
    assert.equal(expandPlaceholders("${PLUGIN_ROOT}", { root: "/odd/${PLUGIN_DATA}", data: "/data" }), "/odd/${PLUGIN_DATA}");
});

test("{§agent-plugins-expansion} any other placeholder stays literal", () => {
    assert.equal(expandPlaceholders("${HOME}/${PLUGIN_ROOTS}/$PLUGIN_ROOT/${plugin_root}", { root: "/r", data: "/d" }), "${HOME}/${PLUGIN_ROOTS}/$PLUGIN_ROOT/${plugin_root}");
});

test("{§agent-plugins-manifest} a canonical identifier names its version; nothing else does", () => {
    assert.equal(schemaVersion("https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", "plugin"), "1.1.0");
    assert.equal(schemaVersion("https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", "plugin"), null);
    assert.equal(schemaVersion("https://example.com/schemas/1.0.0/plugin.schema.json", "plugin"), null);
});
