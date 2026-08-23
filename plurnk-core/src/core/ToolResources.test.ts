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

    assert.deepEqual(resources.map(({ pathname }) => pathname), ["/skills/plurnk/example.md"]);
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

    assert.deepEqual(resources.map(({ pathname }) => pathname), [
        "/skills/plurnk/gitea.md",
        "/skills/plurnk/gitea/index.md",
        "/skills/plurnk/gitea/issue%2Fread.md",
    ]);
    const family = resources[0]?.content ?? "";
    assert.match(family, /^## Invocation\n\n```plurnk\n## EXEC0[\s\S]*\n```$/m);
    assert.match(
        family,
        /^## EXEC0 \[gitea\] \(index\) <!-- List repository issues\. \(details: worker:\/\/~\/skills\/plurnk\/gitea\/index\.md\) -->\n\{"owner"\?: string\}$/m,
    );
    assert.match(
        family,
        /^## EXEC0 \[gitea\] \(issue\/read\) <!-- Read one issue and its discussion\. \(details: worker:\/\/~\/skills\/plurnk\/gitea\/issue%2Fread\.md\) -->\n\{"owner": string, "repo": string, "index": integer\}$/m,
    );
    assert.doesNotMatch(family, /## FIND0/);
    assert.doesNotMatch(resources[0]?.content ?? "", /tool_name/, "the family document cannot advertise a rejected generic target");

    const issue = resources.find(({ pathname }) => pathname.endsWith("issue%2Fread.md"))?.content ?? "";
    assert.match(
        issue,
        /^## Summary\n\n`EXEC \[gitea\] \(issue\/read\) <!-- Read one issue and its discussion\. -->`$/m,
    );
    assert.match(issue, /^## Invocation$/m);
    assert.match(issue, /`## EXEC0 \[gitea\] \(issue\/read\) <!-- Read one issue and its discussion\. -->`/);
    assert.match(issue, /^Signature: `\{"owner": string, "repo": string, "index": integer\}`$/m);
    assert.match(issue, /^## Inputs$/m);
    assert.match(issue, /^\| `owner` \| yes \| `string` \| Repository owner\. \|$/m);
    assert.doesNotMatch(issue, /output schema/i);
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
