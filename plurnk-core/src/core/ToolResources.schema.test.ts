import assert from "node:assert/strict";
import test from "node:test";
import { Validator, type JsonSchema } from "@plurnk/plurnk-contracts";
import ToolResources from "./ToolResources.ts";

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
    assert.equal(detail?.pathname, "/_plurnk/tools/gitea/issue%2Fread.md");
    assert.match(family!.content, /### EXEC0 \[gitea\] \(issue\/read\) <!-- List issues\. Schema: worker:\/\/~\/_plurnk\/tools\/gitea\/issue%2Fread\.md -->\n\{"repo_id": integer, "filter": object, "labels": array, "mode": string, "selector": unknown\}/);
    assert.doesNotMatch(family!.content, /page|oneOf|Selection|minItems/);
    assert.ok(detail!.content.includes(description), "complete multiline description is preserved");
    assert.deepEqual(JSON.parse(detail!.content.split("## Input schema\n\n```json\n")[1]!.split("\n```", 1)[0]!), schema);
    assert.doesNotMatch(detail!.content, /^## Summary$/m, "schema docs do not impersonate family summaries");
    assert.deepEqual(schema, before, "projection never mutates a server's schema");
    assert.equal(render("other")[1]?.pathname, "/_plurnk/tools/other/issue%2Fread.md");
});

test("{§executor-input-schema-preview} complex conditional requirements stay in the raw schema", () => {
    const conditional = { type: "object", oneOf: [
        { properties: { first: { type: "string" } }, required: ["first"] },
        { properties: { second: { type: "number" } }, required: ["second"] },
    ] };
    const [family, detail] = render("conditional", conditional);
    assert.match(family!.content, /-->\n\{\}\n/);
    assert.doesNotMatch(family!.content, /first|second|oneOf/);
    assert.ok(detail!.content.includes(JSON.stringify(conditional, null, 2)));
});

test("{§tools-resource-discovery} annotation normalization cannot rewrite schema addresses", () => {
    const [family, detail] = render("gitea--private");
    assert.ok(family!.content.includes(`Schema: worker://~${detail!.pathname} -->`));
});

test("{§executor-input-schema-preview} general schema-backed runtimes also expose an on-demand schema", () => {
    const [family, detail] = ToolResources.render({
        runtime: "query", summary: "Run a query.", details: description, registry: null,
        invocation: { body: { role: "JSON arguments", required: true }, inputSchema: schema },
    });
    assert.equal(detail!.pathname, "/_plurnk/plurnk/query/input.md");
    assert.ok(family!.content.includes(`Schema: worker://~${detail!.pathname} -->`));
    assert.ok(family!.content.includes('{"repo_id": integer, "filter": object, "labels": array, "mode": string, "selector": unknown}'));
    assert.ok(detail!.content.includes(JSON.stringify(schema, null, 2)));
});

test("{§executor-input-schema-preview} includes original repository-owned referenced schemas without fetching external references", () => {
    const ref = "https://schemas.plurnk.xyz/v0/McpServerDefinition.json";
    const input = { type: "object", required: ["definition"], properties: { definition: { $ref: ref } } };
    const [, detail] = render("mcp", input);
    assert.ok(detail!.content.includes(JSON.stringify(input, null, 2)));
    assert.ok(detail!.content.includes(JSON.stringify(Validator.schemaByRef(ref), null, 2)));
    const external = { $ref: "https://not-a-server.invalid/schema.json" };
    assert.ok(render("external", external)[1]!.content.includes(JSON.stringify(external, null, 2)));
});
