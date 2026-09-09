import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Lexer } from "marked";
import ToolResources from "./ToolResources.ts";
import { functionalityRuntimeDecl, FUNCTIONALITY_VERBS } from "../server/FunctionalityManager.ts";

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
        /^## Summary\n\n````example <!-- Compute a thing\. -->\\nsomething\\n````$/m,
    );
    assert.match(content, /^## Invocation$/m);
    assert.match(content, /^\| body \| required: query \|$/m);
    assert.match(content, /````example <!-- Compute a thing\. -->\nsomething\n````/);
    const summary = content.split("## Summary\n\n")[1]!.split("\n\n")[0]!;
    assert.equal(Lexer.lex(summary)[0]?.type, "paragraph", "the generic Markdown Summary projection can discover the invocation");
    const parsed = PlurnkParser.parseStatements(summary.replaceAll("\\n", "\n"));
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0]?.kind, "statement");
    if (parsed.items[0]?.kind === "statement") {
        assert.equal(parsed.items[0].statement.op, "EXEC");
        assert.equal((parsed.items[0].statement as { executor: string }).executor, "example");
        assert.equal(parsed.items[0].statement.body, "something");
    }
    assert.match(content, /^## Scope$/m);
});

test("{§tools-resource-discovery} retains authored non-schema invocations and supplemental details", () => {
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
        "authored witnesses without input schemas need no schema document",
    );
    const family = resources[0]?.content ?? "";
    assert.match(family, /^## Summary\n\nUse enabled tools from the gitea MCP server\.$/m);
    assert.match(family, /^## Tools\n\n````gitea[\s\S]*\n````$/m);
    assert.match(
        family,
        /^````gitea \(index\) <!-- List repository issues\. -->\n\{"owner"\?: string\}\n````$/m,
        "the invocation line is the whole teaching for a detail-less tool — no pointer",
    );
    assert.match(
        family,
        /^````gitea \(issue\/read\) <!-- Read one issue and its discussion\. -->\n\{"owner": string, "repo": string, "index": integer\}\n````$/m,
    );
    assert.doesNotMatch(family, /Schema: worker:/, "no schema is fabricated for authored signatures");
    assert.doesNotMatch(family, /```FIND/);
    assert.doesNotMatch(family, /tool_name/, "the family document cannot advertise a rejected generic target");
    // A tool's details are a SECTION of the family document, its headings demoted.
    assert.match(family, /^## `issue\/read`$/m);
    assert.match(family, /^### Inputs$/m, "nested detail headings demote beneath the target section");
    assert.match(family, /^\| `owner` \| yes \| `string` \| Repository owner\. \|$/m);
    assert.doesNotMatch(family, /^## `index`$/m, "a detail-less tool earns no section");
});

test("{§capability-admission} derives an inventory summary from the effective exact tools", () => {
    const resources = ToolResources.render({
        runtime: "fixture",
        summary: { from: "tools" },
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "tool", required: true, kind: "literal" },
            example: { target: "tool_name" },
        },
        details: "",
        registry: {
            tools: [{
                target: "echo",
                summary: "Echo one message.",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "tool", required: true, kind: "literal" },
                    signature: '{"message": string}',
                },
            }],
        },
    });

    const family = resources[0]?.content ?? "";
    assert.match(family, /^## Summary\n\n````fixture \(echo\)\\n\{"message": string\}\\n````$/m);
    assert.doesNotMatch(family, /fail/);
});

test("{§tools-resource-discovery} keeps a concrete invocation's multiline body on one summary line", () => {
    const summary = "```fixture (echo) <!-- Echo structured input -->```";
    const body = '{\n  "message": "hello"\n}';
    const resources = ToolResources.render({
        runtime: "fixture", summary, details: "",
        invocation: { body: { role: "JSON arguments", required: true }, example: { target: "echo", body } },
        registry: { tools: [{
            target: "echo", summary: "Echo structured input.",
            invocation: {
                body: { role: "JSON arguments", required: true },
                target: { role: "tool", required: true, kind: "literal" },
                example: { body },
            },
        }] },
    });
    const document = resources[0]!.content;
    const renderedSummary = document.split("## Summary\n\n")[1]!.split("\n\n")[0];
    assert.equal(renderedSummary, `\`${summary.slice(0, -3)}\\n${body.replaceAll("\n", "\\n")}\\n\`\`\`\``);
    assert.ok(document.includes(`\`\`\`\`fixture (echo) <!-- Echo structured input. -->
${body}
\`\`\`\``), "the full invocation retains its physical newlines");
});

test("{§tool-document-header-only} a registry-less runtime with no details is marked invocation-only in its summary", () => {
    const invocation = { body: { role: "the program", required: false }, example: { body: "1+1" } };
    const [bare] = ToolResources.render({ runtime: "calc", summary: "Evaluate calculations.", invocation, details: "   ", registry: null });
    assert.match(bare!.content, /^````calc <!-- Evaluate calculations\. \(invocation only\) -->/mu, "the summary line, and so the catalog row, says the document is header-only");
    const [taught] = ToolResources.render({ runtime: "calc", summary: "Evaluate calculations.", invocation, details: "Set `scale` first.", registry: null });
    assert.doesNotMatch(taught!.content, /invocation only/u, "a runtime with a body is not marked");
    assert.ok(taught!.content.endsWith("Set `scale` first."), "the body closes the document");
});

test("{§functionality-model-projection} manager summaries advertise effective verbs in lifecycle order", () => {
    for (const verbs of [FUNCTIONALITY_VERBS, ["list", "discover"]]) {
        const declaration = functionalityRuntimeDecl("mcp", "Manage MCP servers", "");
        const [resource] = ToolResources.render({
            runtime: "mcp", ...declaration, details: "",
            registry: { tools: verbs.map((target) => ({
                target, summary: target, invocation: declaration.invocation,
            })) },
        });
        const summary = resource!.content.split("## Summary\n\n")[1]!.split("\n")[0];
        assert.equal(summary, `\`\`\`\`mcp (${verbs.join("|")}) <!-- Manage MCP servers -->\`\`\`\``);
    }
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
