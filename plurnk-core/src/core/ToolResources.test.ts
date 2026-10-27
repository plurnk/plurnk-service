import assert from "node:assert/strict";
import test, { describe } from "node:test";
import ToolResources from "./ToolResources.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Lexer } from "marked";
import { plurnkRuntimeDecl } from "../server/FunctionalityManager.ts";
import { isExecution, Validator, type JsonSchema } from "@plurnk/plurnk-contracts";

describe("ToolResources", () => {
test("{§tools-resource-materialization} renders a general runtime as one self-describing resource", () => {
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
        /^## Summary\n\n```example <!-- Compute a thing\. -->\\nsomething\\n```$/m,
    );
    assert.match(content, /^## Invocation$/m);
    assert.match(content, /^\| body \| required: query \|$/m);
    assert.match(content, /```example <!-- Compute a thing\. -->\nsomething\n```/);
    const summary = content.split("## Summary\n\n")[1].split("\n\n")[0];
    assert.equal(Lexer.lex(summary)[0]?.type, "paragraph", "the generic Markdown Summary projection can discover the invocation");
    const parsed = PlurnkParser.parseStatements(summary.replaceAll("\\n", "\n"), { executors: ["example", "fixture", "brave", "sh"] });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0]?.kind, "statement");
    if (parsed.items[0]?.kind === "statement") {
        assert.equal(isExecution(parsed.items[0].statement), true);
        if (!isExecution(parsed.items[0].statement)) assert.fail("expected an execution");
        assert.equal(parsed.items[0].statement.runtime, "example");
        assert.equal(parsed.items[0].statement.body, "something");
    }
    assert.match(content, /^## Scope$/m);
});

test("{§tools-resource-materialization} retains authored non-schema invocations and supplemental details", () => {
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
    const runtimeDoc = resources[0]?.content ?? "";
    assert.match(runtimeDoc, /^## Summary\n\nUse enabled tools from the gitea MCP server\.$/m);
    assert.match(runtimeDoc, /^## Tools\n\n```gitea[\s\S]*\n```$/m);
    assert.match(
        runtimeDoc,
        /^```gitea \(index\) <!-- List repository issues\. -->\n\{"owner"\?: string\}\n```$/m,
        "the invocation line is the whole teaching for a detail-less tool — no pointer",
    );
    assert.match(
        runtimeDoc,
        /^```gitea \(issue\/read\) <!-- Read one issue and its discussion\. -->\n\{"owner": string, "repo": string, "index": integer\}\n```$/m,
    );
    assert.doesNotMatch(runtimeDoc, /Schema: session:/, "no schema is fabricated for authored signatures");
    assert.doesNotMatch(runtimeDoc, /```FIND/);
    assert.doesNotMatch(runtimeDoc, /tool_name/, "the runtime document cannot advertise a rejected generic target");
    // A tool's details are a SECTION of the runtime document, its headings demoted.
    assert.match(runtimeDoc, /^## `issue\/read`$/m);
    assert.match(runtimeDoc, /^### Inputs$/m, "nested detail headings demote beneath the target section");
    assert.match(runtimeDoc, /^\| `owner` \| yes \| `string` \| Repository owner\. \|$/m);
    assert.doesNotMatch(runtimeDoc, /^## `index`$/m, "a detail-less tool earns no section");
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

    const runtimeDoc = resources[0]?.content ?? "";
    assert.match(runtimeDoc, /^## Summary\n\n```fixture \(echo\)\\n\{"message": string\}\\n```$/m);
    assert.doesNotMatch(runtimeDoc, /fail/);
});

// {§find} — a runtime's summary is its complete menu, however many tools it has.
test("{§find} a large runtime's inventory summary names every tool", () => {
    const tool = (name: string) => ({
        target: name,
        summary: `${name} does a thing.`,
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "tool", required: true, kind: "literal" as const },
            signature: '{"query": string}',
        },
    });
    const targets = Array.from({ length: 24 }, (_, index) => `tool_number_${index + 1}_with_a_long_name`);
    const resources = ToolResources.render({
        runtime: "gitea",
        summary: { from: "tools" },
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "tool", required: true, kind: "literal" },
            example: { target: "tool_name" },
        },
        details: "",
        registry: { tools: targets.map(tool) },
    });
    const runtimeDoc = resources[0]?.content ?? "";
    const summary = /^## Summary\n\n(.*)$/m.exec(runtimeDoc)?.[1] ?? "";
    assert.ok(Array.from(summary).length > EntryManifest.summaryCodePoints(), "the complete menu is longer than the prose bound");
    assert.match(summary, new RegExp(`^\`\`\`gitea \\(${targets.join("\\|")}\\)`), "every tool is named, in declaration order");
    assert.doesNotMatch(summary, /…/);

    const small = ToolResources.render({
        runtime: "brave",
        summary: { from: "tools", description: "Brave Search MCP Server" },
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "tool", required: true, kind: "literal" },
            example: { target: "tool_name" },
        },
        details: "",
        registry: { tools: ["brave_web_search", "brave_news_search"].map(tool) },
    });
    assert.match(small[0]?.content ?? "", /^## Summary\n\n```brave \(brave_web_search\|brave_news_search\) <!-- Brave Search MCP Server -->/m, "a runtime that fits lists every tool");
});

test("{§tools-resource-materialization} keeps a concrete invocation's multiline body on one summary line", () => {
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
    const document = resources[0].content;
    const renderedSummary = document.split("## Summary\n\n")[1].split("\n\n")[0];
    assert.equal(renderedSummary, `${summary.slice(0, -3)}\\n${body.replaceAll("\n", "\\n")}\\n\`\`\``);
    assert.ok(document.includes(`\`\`\`fixture (echo) <!-- Echo structured input. -->
${body}
\`\`\``), "the full invocation retains its physical newlines");
});

test("{§tools-resource-materialization} a registry-less runtime with no details is marked invocation-only in its summary", () => {
    const invocation = { body: { role: "the program", required: false }, example: { body: "1+1" } };
    const [bare] = ToolResources.render({ runtime: "calc", summary: "Evaluate calculations.", invocation, details: "   ", registry: null });
    assert.match(bare.content, /^```calc <!-- Evaluate calculations\. \(invocation only\) -->/mu, "the summary line, and so the catalog row, says the document is header-only");
    const [taught] = ToolResources.render({ runtime: "calc", summary: "Evaluate calculations.", invocation, details: "Set `scale` first.", registry: null });
    assert.doesNotMatch(taught.content, /invocation only/u, "a runtime with a body is not marked");
    assert.ok(taught.content.endsWith("Set `scale` first."), "the body closes the document");
});

test("{§functionality-model-projection} plurnk runtime summary advertises effective tools in registration order", () => {
    for (const tools of [["env", "mcp", "members", "schedule", "skills", "question"], ["members", "question"]]) {
        const [resource] = ToolResources.render({
            runtime: "plurnk", ...plurnkRuntimeDecl, details: "",
            registry: { tools: tools.map((target) => ({
                target, summary: target, invocation: plurnkRuntimeDecl.invocation,
            })) },
        });
        const summary = resource.content.split("## Summary\n\n")[1].split("\n")[0];
        assert.equal(summary, `\`\`\`plurnk (${tools.join("|")}) <!-- Manage workspace capabilities and ask the user questions. -->\\n\`\`\``);
    }
});

test("{§tools-resource-materialization} percent-encodes exact targets without reserving ordinary tool names", () => {
    assert.equal(ToolResources.targetSegment("index"), "index");
    assert.equal(ToolResources.targetSegment("../issue read"), "..%2Fissue%20read");
    assert.equal(ToolResources.targetSegment("issue%2Fread"), "issue%252Fread");
});

test("{§executor-discovery} an empty exact set publishes no runtime", () => {
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
});

describe("ToolResources.schema", () => {
const schema = {
    type: "object",
    required: ["repo_id", "filter", "labels", "mode", "selector"],
    properties: {
        repo_id: { type: "integer", minimum: 1, description: "Repository identifier." },
        filter: { type: "object", properties: { state: { enum: ["open", "closed"] } } },
        labels: { type: "array", items: { type: "string" }, minItems: 1 },
        mode: { type: "string", enum: ["open", "all"] },
        selector: { $ref: "#/$defs/selector" },
        page: { type: "integer", default: 1 },
    },
    $defs: { selector: { oneOf: [{ type: "string" }, { type: "integer" }] } },
    if: { properties: { mode: { const: "all" } } },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then keyword, not a thenable
    then: { required: ["page"] },
    additionalProperties: false,
};
const description = "List issues.\n\n## Selection\n\nUse mode to select the issue states.\n```json\n{}\n```";
const render = (runtime = "gitea", inputSchema: JsonSchema = schema) => ToolResources.render({
    runtime, resourcesPath: "/tools", summary: { from: "tools" }, details: "",
    invocation: {
        body: { role: "JSON arguments", required: false },
        target: { role: "tool", required: true, kind: "literal" },
        example: { target: "issue/read" },
    },
    registry: { tools: [{
        target: "issue/read", summary: "List issues.", details: description,
        invocation: {
            body: { role: "JSON arguments", required: true },
            target: { role: "tool", required: true, kind: "literal" },
            inputSchema,
        },
    }] },
});

test("{§executor-discovery} catalogs required top-level fields in the skeleton, surfaces enums/options in the aside, and preserves the complete schema separately", () => {
    const before = structuredClone(schema);
    const [family, detail] = render();
    assert.equal(family?.pathname, "/_plurnk/tools/gitea.md");
    assert.equal(detail?.pathname, "/_plurnk/tools/gitea/issue%2Fread.json");
    assert.match(family.content, /```gitea \(issue\/read\) <!-- List issues\. \(filter: \{state\?: "open"\|"closed"\}, mode: "open"\|"all"; page\?: integer\) Schema: workspace:\/\/\/_plurnk\/tools\/gitea\/issue%2Fread\.json -->\n\{"repo_id": 0, "filter": \{\}, "labels": \[\], "mode": "open", "selector": null\}\n```/);
    assert.doesNotMatch(family.content, /oneOf|Selection|minItems/);
    const parsed = JSON.parse(detail.content) as Record<string, unknown>;
    assert.equal(parsed.description, description, "complete multiline description is preserved");
    assert.equal(parsed.title, "gitea: issue/read");
    assert.deepEqual(parsed.properties, schema.properties);
    assert.deepEqual(parsed.required, schema.required);
    assert.doesNotMatch(detail.content, /^## Summary$/m, "schema docs do not impersonate runtime summaries");
    assert.deepEqual(schema, before, "projection never mutates a server's schema");
    assert.equal(render("other")[1]?.pathname, "/_plurnk/tools/other/issue%2Fread.json");
});

test("{§executor-discovery} complex conditional requirements stay in the raw schema", () => {
    const conditional = { type: "object", oneOf: [
        { properties: { first: { type: "string" } }, required: ["first"] },
        { properties: { second: { type: "number" } }, required: ["second"] },
    ] };
    const [family, detail] = render("conditional", conditional);
    assert.match(family.content, /-->\n\{\}\n/);
    assert.doesNotMatch(family.content, /first|second|oneOf/);
    const parsed = JSON.parse(detail.content) as Record<string, unknown>;
    assert.deepEqual(parsed.oneOf, conditional.oneOf);
});

test("{§executor-discovery} links an exact JSON catalog without changing the compact summary", () => {
    const definitions = [{ name: "issue/read", description, inputSchema: schema,
        outputSchema: { type: "object" }, annotations: { readOnlyHint: true },
        _meta: { vendor: { revision: 1 } },
    }, { name: "issue_write", inputSchema: { type: "object", additionalProperties: false } }];
    const before = structuredClone(definitions);
    const invocation = {
        body: { role: "JSON arguments", required: true },
        target: { role: "tool", required: true, kind: "literal" as const },
        inputSchema: schema,
    };
    const tools = definitions.map((definition) => ({
        target: definition.name, summary: "Manage issues.",
        invocation: { ...invocation, inputSchema: definition.inputSchema }, definition,
    }));
    const source = { runtime: "gitea", resourcesPath: "/tools", summary: { from: "tools" as const },
        details: "", invocation, registry: { tools } };
    const resources = ToolResources.render(source);
    const catalog = resources.find(({ pathname }) => pathname === "/_plurnk/tools/gitea.json");
    assert.ok(catalog, "the family has a sibling JSON catalog");
    assert.deepEqual(JSON.parse(catalog.content), { tools: definitions });
    assert.equal(catalog.content, JSON.stringify({ tools: definitions }, null, 2));
    assert.match(resources[0].content, /workspace:\/\/\/_plurnk\/tools\/gitea\.json/);
    assert.doesNotMatch(resources[0].content, /outputSchema|vendor|revision/);
    assert.deepEqual(resources.slice(1, 3).map(({ pathname }) => pathname), [
        "/_plurnk/tools/gitea/issue%2Fread.json", "/_plurnk/tools/gitea/issue_write.json",
    ], "individual input schemas remain separately readable");
    const withoutDefinitions = ToolResources.render({ ...source, registry: {
        tools: tools.map((tool) => ({ target: tool.target, summary: tool.summary, invocation: tool.invocation })),
    } });
    const summary = (content: string) => content.split("## Summary\n\n")[1].split("\n\n")[0];
    assert.equal(summary(resources[0].content), summary(withoutDefinitions[0].content));
    assert.ok(!withoutDefinitions.some(({ pathname }) => pathname === catalog.pathname));
    assert.deepEqual(ToolResources.render({ ...source, registry: { tools: [] } }), []);
    assert.deepEqual(definitions, before);
});

test("{§tools-resource-materialization} a featured exact tool includes its required input without expanding the family", () => {
    const tool = {
        target: "search", summary: "Search documents.",
        invocation: {
            body: { role: "JSON arguments", required: true },
            inputSchema: { type: "object", required: ["query"], properties: {
                query: { type: "string" }, page: { type: "integer" },
            } },
        },
    };
    const family = (summary: string) => ToolResources.render({
        runtime: "brave", summary, details: "", invocation: tool.invocation,
        registry: { tools: [tool, { ...tool, target: "news" }] },
    })[0].content.split("## Summary\n\n")[1].split("\n\n")[0];
    const heading = "```brave (search) <!-- Search documents -->";
    assert.equal(family(`${heading}\`\`\``), `${heading}\\n{"query": ""}\\n\`\`\``);
    for (const authored of [
        "Search documents and news.",
        "```brave (search|news)```",
        "```brave (disabled)```",
        "```other (search)```",
        `${heading}\\n{"query":"example"}\\n\`\`\``,
    ]) assert.equal(family(authored), authored);
});

test("{§tools-resource-materialization} aside normalization cannot rewrite schema addresses", () => {
    const [family, detail] = render("gitea--private");
    assert.ok(family.content.includes(`Schema: workspace://${detail.pathname} -->`));
});

test("{§executor-discovery} general schema-backed runtimes also expose an on-demand schema", () => {
    const [family, detail] = ToolResources.render({
        runtime: "query", summary: "Run a query.", details: description, registry: null,
        invocation: { body: { role: "JSON arguments", required: true }, inputSchema: schema },
    });
    assert.equal(detail.pathname, "/_plurnk/plurnk/query/input.json");
    assert.ok(family.content.includes(`Schema: workspace://${detail.pathname} -->`));
    assert.ok(family.content.includes('{"repo_id": 0, "filter": {}, "labels": [], "mode": "open", "selector": null}'));
    assert.deepEqual((JSON.parse(detail.content) as Record<string, unknown>).properties, schema.properties);
});

test("{§executor-discovery} includes original repository-owned referenced schemas without fetching external references", () => {
    const ref = "https://schemas.plurnk.xyz/v0/McpServerDefinition.json";
    const input = { type: "object", required: ["definition"], properties: { definition: { $ref: ref } } };
    const [, detail] = render("mcp", input);
    const parsed = JSON.parse(detail.content) as Record<string, unknown>;
    assert.deepEqual(parsed.properties, input.properties);
    assert.deepEqual((parsed.$defs as Record<string, unknown>)[ref], Validator.schemaByRef(ref));
    const external = { $ref: "https://not-a-server.invalid/schema.json" };
    const [, extDetail] = render("external", external);
    assert.equal((JSON.parse(extDetail.content) as Record<string, unknown>).$ref, external.$ref);
});

test("{§executor-discovery} surfaces optional properties, nested object/array shapes, and bounded tails before the schema pointer (#1228)", () => {
    const withOptions = ToolResources.render({
        runtime: "gitea", resourcesPath: "/tools", summary: { from: "tools" }, details: "",
        invocation: { body: { role: "JSON arguments", required: true }, target: { role: "tool", required: true, kind: "literal" }, example: { target: "search" } },
        registry: { tools: [{
            target: "search", summary: "Search repos.", details: "",
            invocation: {
                body: { role: "JSON arguments", required: true },
                target: { role: "tool", required: true, kind: "literal" },
                inputSchema: {
                    type: "object", required: ["query"],
                    properties: {
                        query: { type: "string" },
                        page: { type: "integer" },
                        sort: { type: "string" },
                        state: { type: "string", enum: ["open", "closed", "all"] },
                        labels: { type: "array", items: { type: "string" } },
                    },
                },
            },
        }] },
    })[0].content;
    assert.match(withOptions, /```gitea \(search\) <!-- Search repos\. \(page\?: integer, sort\?: string, state\?: "open"\|"closed"\|"all", labels\?: string\[\]\) Schema: workspace:\/\/\/_plurnk\/tools\/gitea\/search\.json -->\n\{"query": ""\}\n```/);

    const fillForm = {
        type: "object",
        required: ["fields"],
        properties: {
            fields: {
                type: "array",
                items: {
                    type: "object",
                    required: ["target", "name", "type", "value"],
                    properties: {
                        element: { type: "string" },
                        name: { type: "string" },
                        target: { type: "string" },
                        type: { type: "string", enum: ["textbox", "checkbox", "radio", "combobox", "slider"] },
                        value: { type: "string" },
                    },
                },
            },
        },
    };
    assert.equal(
        ToolResources.fence("browser", {
            body: { role: "JSON arguments", required: true },
            target: { role: "MCP tool", required: true, kind: "literal" },
            inputSchema: fillForm,
        }, "browser_fill_form"),
        '```browser (browser_fill_form) <!-- (fields: {target: string, name: string, type: "textbox"|"checkbox"|"radio"|"combobox"|"slider", value: string, element?: string}[]) -->\n{"fields": []}\n```',
    );

    const noOptions = ToolResources.render({
        runtime: "gitea", resourcesPath: "/tools", summary: { from: "tools" }, details: "",
        invocation: { body: { role: "JSON arguments", required: true }, target: { role: "tool", required: true, kind: "literal" }, example: { target: "search" } },
        registry: { tools: [{
            target: "search", summary: "Search repos.", details: "",
            invocation: {
                body: { role: "JSON arguments", required: true },
                target: { role: "tool", required: true, kind: "literal" },
                inputSchema: {
                    type: "object", required: ["query"],
                    properties: { query: { type: "string" } },
                },
            },
        }] },
    })[0].content;
    assert.match(noOptions, /```gitea \(search\) <!-- Search repos\. Schema: workspace:\/\/\/_plurnk\/tools\/gitea\/search\.json -->\n\{"query": ""\}\n```/);
});
});
