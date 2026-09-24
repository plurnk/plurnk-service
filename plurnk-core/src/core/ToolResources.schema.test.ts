import assert from "node:assert/strict";
import test from "node:test";
import { Validator, type JsonSchema } from "@plurnk/plurnk-contracts";
import ToolResources from "./ToolResources.ts";
import ToolInputSchema from "./ToolInputSchema.ts";

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

test("{§executor-input-schema-preview} catalogs only required top-level fields and preserves the complete schema separately", () => {
    const before = structuredClone(schema);
    const [family, detail] = render();
    assert.equal(family?.pathname, "/_plurnk/tools/gitea.md");
    assert.equal(detail?.pathname, "/_plurnk/tools/gitea/issue%2Fread.json");
    assert.match(family!.content, /```gitea \(issue\/read\) <!-- List issues\. \(\+1 opt\) Schema: worker:\/\/\/_plurnk\/tools\/gitea\/issue%2Fread\.json -->\n\{"repo_id": 0, "filter": \{\}, "labels": \[\], "mode": "open", "selector": null\}\n```/);
    assert.doesNotMatch(family!.content, /page|oneOf|Selection|minItems/);
    const parsed = JSON.parse(detail!.content) as Record<string, unknown>;
    assert.equal(parsed.description, description, "complete multiline description is preserved");
    assert.equal(parsed.title, "gitea: issue/read");
    assert.deepEqual(parsed.properties, schema.properties);
    assert.deepEqual(parsed.required, schema.required);
    assert.doesNotMatch(detail!.content, /^## Summary$/m, "schema docs do not impersonate family summaries");
    assert.deepEqual(schema, before, "projection never mutates a server's schema");
    assert.equal(render("other")[1]?.pathname, "/_plurnk/tools/other/issue%2Fread.json");
});

test("{§executor-input-schema-preview} complex conditional requirements stay in the raw schema", () => {
    const conditional = { type: "object", oneOf: [
        { properties: { first: { type: "string" } }, required: ["first"] },
        { properties: { second: { type: "number" } }, required: ["second"] },
    ] };
    const [family, detail] = render("conditional", conditional);
    assert.match(family!.content, /-->\n\{\}\n/);
    assert.doesNotMatch(family!.content, /first|second|oneOf/);
    const parsed = JSON.parse(detail!.content) as Record<string, unknown>;
    assert.deepEqual(parsed.oneOf, conditional.oneOf);
});

test("{§tools-summary-invocation} a featured exact tool includes its required input without expanding the family", () => {
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
    })[0]!.content.split("## Summary\n\n")[1]!.split("\n\n")[0];
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

test("{§tools-resource-discovery} aside normalization cannot rewrite schema addresses", () => {
    const [family, detail] = render("gitea--private");
    assert.ok(family!.content.includes(`Schema: worker://${detail!.pathname} -->`));
});

test("{§executor-input-schema-preview} general schema-backed runtimes also expose an on-demand schema", () => {
    const [family, detail] = ToolResources.render({
        runtime: "query", summary: "Run a query.", details: description, registry: null,
        invocation: { body: { role: "JSON arguments", required: true }, inputSchema: schema },
    });
    assert.equal(detail!.pathname, "/_plurnk/plurnk/query/input.json");
    assert.ok(family!.content.includes(`Schema: worker://${detail!.pathname} -->`));
    assert.ok(family!.content.includes('{"repo_id": 0, "filter": {}, "labels": [], "mode": "open", "selector": null}'));
    assert.deepEqual((JSON.parse(detail!.content) as Record<string, unknown>).properties, schema.properties);
});

test("{§executor-input-schema-preview} includes original repository-owned referenced schemas without fetching external references", () => {
    const ref = "https://schemas.plurnk.xyz/v0/McpServerDefinition.json";
    const input = { type: "object", required: ["definition"], properties: { definition: { $ref: ref } } };
    const [, detail] = render("mcp", input);
    const parsed = JSON.parse(detail!.content) as Record<string, unknown>;
    assert.deepEqual(parsed.properties, input.properties);
    assert.deepEqual((parsed.$defs as Record<string, unknown>)[ref], Validator.schemaByRef(ref));
    const external = { $ref: "https://not-a-server.invalid/schema.json" };
    const [, extDetail] = render("external", external);
    assert.equal((JSON.parse(extDetail!.content) as Record<string, unknown>).$ref, external.$ref);
});

test("{§executor-input-schema-preview} a required closed set of strings shows its values; a long or mixed set keeps its type (#762)", () => {
    assert.equal(ToolInputSchema.preview({
        type: "object",
        required: ["method", "owner", "issue_number"],
        properties: {
            method: { type: "string", enum: ["get", "get_comments", "get_labels"] },
            owner: { type: "string" },
            issue_number: { type: "number" },
        },
    }), '{"method": "get", "owner": "", "issue_number": 0}');
    assert.equal(ToolInputSchema.preview({
        type: "object", required: ["a", "b", "c", "d"],
        properties: {
            a: { type: "string", enum: Array.from({ length: 9 }, (_, i) => `v${i}`) },
            b: { type: "string", enum: ["x", 1] },
            c: { type: "boolean" },
            d: { type: "array" },
        },
    }), '{"a": "v0", "b": "x", "c": false, "d": []}');
});

test("{§executor-input-schema-preview} notes omitted optional properties as (+N opt) before the schema pointer", () => {
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
                    properties: { query: { type: "string" }, page: { type: "integer" }, sort: { type: "string" } },
                },
            },
        }] },
    })[0]!.content;
    assert.match(withOptions, /```gitea \(search\) <!-- Search repos\. \(\+2 opt\) Schema: worker:\/\/\/_plurnk\/tools\/gitea\/search\.json -->\n\{"query": ""\}\n```/);

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
    })[0]!.content;
    assert.match(noOptions, /```gitea \(search\) <!-- Search repos\. Schema: worker:\/\/\/_plurnk\/tools\/gitea\/search\.json -->\n\{"query": ""\}\n```/);
});

