import assert from "node:assert/strict";
import test from "node:test";
import ToolResources from "./ToolResources.ts";

test("{§tools-resource-discovery} renders a general runtime as one self-describing resource", () => {
    const resources = ToolResources.render({
        runtime: "example",
        summary: "Compute a thing.",
        invocation: {
            body: { role: "query", required: true },
            example: { body: "something" },
        },
        details: "## Scope\n\nRead-only.",
        registry: null,
    });

    assert.deepEqual(resources.map(({ pathname }) => pathname), ["/_plurnk/plurnk/example.md"]);
    const content = resources[0]?.content ?? "";
    assert.match(content, /^# example$/m);
    assert.match(
        content,
        /^## Summary\n\n`EXEC \[example\] <!-- Compute a thing\. -->\\nsomething`$/m,
    );
    assert.match(content, /^## Invocation$/m);
    assert.match(content, /^\| body \| required: query \|$/m);
    assert.match(content, /```plurnk\n## EXEC0 \[example\] <!-- Compute a thing\. -->\nsomething\n```/);
    assert.match(content, /^## Scope$/m);
});

test("{§tools-resource-discovery} renders an exact registry as one family and one document per target", () => {
    const resources = ToolResources.render({
        runtime: "gitea",
        summary: "Use enabled tools from the gitea MCP server.",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "tool_name" },
        },
        details: "",
        registry: {
            tools: [
                {
                    target: "issue/read",
                    summary: "Read one issue and its discussion.",
                    invocation: {
                        body: { role: "JSON arguments", required: true },
                        target: { role: "MCP tool", required: true, kind: "literal" },
                        signature: '{"owner": string, "repo": string, "index": integer}',
                    },
                    details: "## Inputs\n\n| Property | Required | Contract | Description |\n| --- | --- | --- | --- |\n| `owner` | yes | `string` | Repository owner. |",
                },
                {
                    target: "index",
                    summary: "List repository issues.",
                    invocation: {
                        body: { role: "JSON arguments", required: false },
                        target: { role: "MCP tool", required: true, kind: "literal" },
                        signature: '{"owner"?: string}',
                    },
                },
            ],
        },
    });

    assert.deepEqual(
        resources.map(({ pathname }) => pathname),
        ["/_plurnk/plurnk/gitea.md"],
        "one document per registried runtime — no child documents, shown or existing (#336)",
    );
    const family = resources[0]?.content ?? "";
    assert.match(family, /^## Invocation\n\n```plurnk\n## EXEC0[\s\S]*\n```$/m);
    assert.match(
        family,
        /^## EXEC0 \[gitea\] \(index\) <!-- List repository issues\. -->\n\{"owner"\?: string\}$/m,
        "the invocation line is the whole teaching for a detail-less tool — no pointer",
    );
    assert.match(
        family,
        /^## EXEC0 \[gitea\] \(issue\/read\) <!-- Read one issue and its discussion\. -->\n\{"owner": string, "repo": string, "index": integer\}$/m,
    );
    assert.doesNotMatch(family, /details: worker:/, "child-document pointers no longer exist");
    assert.doesNotMatch(family, /## FIND0/);
    assert.doesNotMatch(family, /tool_name/, "the family document cannot advertise a rejected generic target");
    // A tool's details are a SECTION of the family document, its headings demoted.
    assert.match(family, /^## `issue\/read`$/m);
    assert.match(family, /^### Inputs$/m, "nested detail headings demote beneath the target section");
    assert.match(family, /^\| `owner` \| yes \| `string` \| Repository owner\. \|$/m);
    assert.doesNotMatch(family, /^## `index`$/m, "a detail-less tool earns no section");
});

test("{§tools-resource-discovery} percent-encodes exact targets without reserving ordinary tool names", () => {
    assert.equal(ToolResources.targetSegment("index"), "index");
    assert.equal(ToolResources.targetSegment("../issue read"), "..%2Fissue%20read");
    assert.equal(ToolResources.targetSegment("issue%2Fread"), "issue%252Fread");
});

test("{§executor-tool-registry} an empty exact set publishes no executable family", () => {
    assert.deepEqual(ToolResources.render({
        runtime: "resources-only",
        summary: "An MCP server with no enabled tools.",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "tool_name" },
        },
        details: "",
        registry: { tools: [] },
    }), []);
});
