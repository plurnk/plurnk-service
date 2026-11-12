import assert from "node:assert/strict";
import test, { describe } from "node:test";
import ToolResources from "./ToolResources.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Lexer } from "marked";
import { plurnkRuntimeDecl } from "../server/FunctionalityManager.ts";
import { ALL_CORE_OPERATION_TOOLS } from "../schemes/CoreOperationTools.ts";
import { isExecution, PLURNK_OPS, Validator, type JsonSchema } from "@plurnk/plurnk-contracts";

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

    assert.deepEqual(resources.map(({ scheme, pathname }) => `${scheme}://${pathname}`), ["plurnk:///example.md"]);
    const content = resources[0]?.content ?? "";
    assert.match(content, /^# example$/m);
    assert.match(
        content,
        /^## Summary\n\nplurnk\.example\("something"\) \/\/ Compute a thing\.$/m,
    );
    assert.match(content, /^## Invocation$/m);
    assert.match(content, /^\| body \| required: query \|$/m);
    assert.match(content, /plurnk\.example\("something"\) \/\/ Compute a thing\./);
    const summary = content.split("## Summary\n\n")[1].split("\n\n")[0];
    assert.equal(Lexer.lex(summary)[0]?.type, "paragraph", "the generic Markdown Summary projection can discover the Code Mode invocation");
    const parsed = PlurnkParser.parseStatements(summary, { executors: ["example", "fixture", "brave", "sh"] });
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
        resources.map(({ scheme, pathname }) => `${scheme}://${pathname}`),
        ["plurnk:///gitea.md"],
        "authored witnesses without input schemas need no schema document",
    );
    const runtimeDoc = resources[0]?.content ?? "";
    assert.match(runtimeDoc, /^## Summary\n\nUse enabled tools from the gitea MCP server\.$/m);
    assert.match(runtimeDoc, /^## Tools\n\ngitea[\s\S]*$/m);
    assert.match(
        runtimeDoc,
        /^gitea\.index\(\{"owner"\?: string\}\) \/\/ List repository issues\.$/m,
        "the invocation line is the whole teaching for a detail-less tool — no pointer",
    );
    assert.match(
        runtimeDoc,
        /^gitea\["issue\/read"\]\(\{"owner": string, "repo": string, "index": integer\}\) \/\/ Read one issue and its discussion\.$/m,
    );
    assert.doesNotMatch(runtimeDoc, /Schema: session:/, "no schema is fabricated for authored signatures");
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
    assert.match(runtimeDoc, /^## Summary\n\nfixture\.echo\(\{"message": string\}\)$/m);
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
    assert.match(summary, new RegExp(`^gitea\\["${targets.join("\\|")}"\\]\\(\\)`), "every tool is named, in declaration order");
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
    assert.match(small[0]?.content ?? "", /^## Summary\n\nbrave\["brave_web_search\|brave_news_search"\]\(\) \/\/ Brave Search MCP Server/m, "a runtime that fits lists every tool");
});

test("{§tools-resource-materialization} keeps a concrete invocation's multiline body inside the summary witness", () => {
    const summary = "fixture.echo() // Echo structured input";
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
    assert.equal(renderedSummary, `fixture.echo(${body}) // Echo structured input`);
    assert.ok(document.includes(`fixture.echo(${body}) // Echo structured input.`), "the full invocation retains its physical newlines");
});

test("{§tools-resource-materialization} a registry-less runtime with no details is marked invocation-only in its summary", () => {
    const invocation = { body: { role: "the program", required: false }, example: { body: "1+1" } };
    const [bare] = ToolResources.render({ runtime: "calc", summary: "Evaluate calculations.", invocation, details: "   ", registry: null });
    assert.match(bare.content, /^plurnk\.calc\("1\+1"\) \/\/ Evaluate calculations\. \(invocation only\)$/mu, "the summary line, and so the catalog row, says the document is header-only");
    const [taught] = ToolResources.render({ runtime: "calc", summary: "Evaluate calculations.", invocation, details: "Set `scale` first.", registry: null });
    assert.doesNotMatch(taught.content, /invocation only/u, "a runtime with a body is not marked");
    assert.ok(taught.content.endsWith("Set `scale` first."), "the body closes the document");
});

test("{§functionality-model-projection} plurnk runtime summary advertises effective tools in registration order", () => {
    for (const tools of [["env", "mcp", "skills", "personas", "schedule", "members", "question"], ["env", "members"]] as const) {
        const [resource] = ToolResources.render({
            runtime: plurnkRuntimeDecl.name, ...plurnkRuntimeDecl, details: "",
            registry: { tools: tools.map((target) => ({
                target, summary: target, invocation: plurnkRuntimeDecl.invocation,
            })) },
        });
        const summary = resource.content.split("## Summary\n\n")[1].split("\n\n")[0];
        assert.equal(summary, `plurnk[${JSON.stringify(tools.join("|"))}]() // Core operations, code execution, workspace configuration (env, mcp, members, personas, schedule, skills), and user questions.`);
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
    assert.equal(family?.scheme, "mcp");
    assert.equal(family?.pathname, "/gitea.md");
    assert.equal(detail?.scheme, "mcp");
    assert.equal(detail?.pathname, "/gitea/issue%2Fread.json");
    assert.match(family.content, /^gitea\["issue\/read"\]\(\{"repo_id": 0, "filter": \{\}, "labels": \[\], "mode": "open", "selector": null\}\) \/\/ List issues\. \(filter: \{state\?: "open"\|"closed"\}, mode: "open"\|"all"; page\?: integer\)$/m);
    assert.doesNotMatch(family.content, /Schema:/);
    assert.doesNotMatch(family.content, /oneOf|Selection|minItems/);
    const parsed = JSON.parse(detail.content) as Record<string, unknown>;
    assert.equal(parsed.description, description, "complete multiline description is preserved");
    assert.equal(parsed.title, "gitea: issue/read");
    assert.deepEqual(parsed.properties, schema.properties);
    assert.deepEqual(parsed.required, schema.required);
    assert.doesNotMatch(detail.content, /^## Summary$/m, "schema docs do not impersonate runtime summaries");
    assert.deepEqual(schema, before, "projection never mutates a server's schema");
    assert.equal(render("other")[1]?.pathname, "/other/issue%2Fread.json");
});

test("{§executor-discovery} top-level object unions preview the first branch and summarize branches in the aside", () => {
    const conditional = { type: "object", oneOf: [
        { properties: { first: { type: "string" } }, required: ["first"] },
        { properties: { second: { type: "number" } }, required: ["second"] },
    ] };
    const [family, detail] = render("conditional", conditional);
    assert.match(family.content, /^conditional\["issue\/read"\]\(\{"first": ""\}\) \/\/ List issues\. \(\{first: string\}\|\{second: number\}\)$/m);
    assert.doesNotMatch(family.content, /oneOf/);
    const parsed = JSON.parse(detail.content) as Record<string, unknown>;
    assert.deepEqual(parsed.oneOf, conditional.oneOf);
});

test("{§executor-discovery} materializes an exact JSON catalog alongside the compact summary", () => {
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
    const catalog = resources.find(({ pathname }) => pathname === "/gitea.json");
    assert.ok(catalog, "the family has a sibling JSON catalog");
    assert.deepEqual(JSON.parse(catalog.content), { tools: definitions });
    assert.equal(catalog.content, JSON.stringify({ tools: definitions }, null, 2));
    assert.doesNotMatch(resources[0].content, /mcp:\/\/\/gitea\.json/);
    assert.doesNotMatch(resources[0].content, /outputSchema|vendor|revision/);
    assert.deepEqual(resources.slice(1, 3).map(({ pathname }) => pathname), [
        "/gitea/issue%2Fread.json", "/gitea/issue_write.json",
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
    assert.equal(family("brave.search() // Search documents"), 'brave.search({"query": ""}) // Search documents');
    assert.equal(family("await brave.search(); // Search documents"), 'brave.search({"query": ""}) // Search documents');
    for (const authored of [
        "Search documents and news.",
        'brave["search|news"]()',
        "brave.disabled()",
        "other.search()",
        'brave.search({"query":"example"}) // Search documents',
    ]) assert.equal(family(authored), authored);
});

test("{§tools-resource-materialization} aside normalization preserves double-hyphen runtime schema paths", () => {
    const [, detail] = render("gitea--private");
    assert.equal(detail.pathname, "/gitea--private/issue%2Fread.json");
});

test("{§executor-discovery} general schema-backed runtimes also expose an on-demand schema", () => {
    const [family, detail] = ToolResources.render({
        runtime: "query", summary: "Run a query.", details: description, registry: null,
        invocation: { body: { role: "JSON arguments", required: true }, inputSchema: schema },
    });
    assert.equal(detail.scheme, "plurnk");
    assert.equal(detail.pathname, "/query/input.json");
    assert.ok(family.content.includes(`Schema: plurnk://${detail.pathname}`));
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

test("{§executor-discovery} surfaces optional properties, nested object/array shapes, and bounded tails in the aside (#1228)", () => {
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
    assert.match(withOptions, /^gitea\.search\(\{"query": ""\}\) \/\/ Search repos\. \(page\?: integer, sort\?: string, state\?: "open"\|"closed"\|"all", labels\?: string\[\]\)$/m);

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
        'browser.browser_fill_form({"fields": []}) // (fields: {target: string, name: string, type: "textbox"|"checkbox"|"radio"|"combobox"|"slider", value: string, element?: string}[])',
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
    assert.match(noOptions, /^gitea\.search\(\{"query": ""\}\) \/\/ Search repos\.$/m);
});

test("{§functionality-model-projection} {§tools-resource-materialization} renders all 15 Core VM operations on mcp:///plurnk.md with parseable examples", () => {
    assert.deepEqual(
        ALL_CORE_OPERATION_TOOLS.map(({ target }) => target).toSorted(),
        [...PLURNK_OPS].toSorted(),
        "every Core VM operation is registered as a plurnk tool",
    );
    const rendered = ToolResources.render({
        runtime: plurnkRuntimeDecl.name,
        ...plurnkRuntimeDecl,
        details: plurnkRuntimeDecl.details ?? "",
        registry: { tools: [...ALL_CORE_OPERATION_TOOLS] },
    });
    const indexDoc = rendered.find(({ scheme, pathname }) => scheme === "mcp" && pathname === "/plurnk.md");
    assert.ok(indexDoc);
    assert.match(
        indexDoc.content,
        /^plurnk\.todo\(\{"items": \[\]\}\) \/\/ Replace the session's remaining TODO list\.$/m,
    );
    assert.match(
        indexDoc.content,
        /^plurnk\.find\(\{"path": ""\}\) \/\/ List matching paths, or match pattern locations inside a path; range pages results\./m,
    );
    assert.match(
        indexDoc.content,
        /^plurnk\.copy\(\{"from": "", "to": ""\}\) \/\/ Copy files, entries, streams, or text regions\. \(from: string\|\{path: string, range\?: string, pattern\?: string, headers\?: object\}, to: string\|\{path: string, range\?: string, pattern\?: string, headers\?: object\}\)$/m,
    );
    assert.doesNotMatch(indexDoc.content, /Schema: mcp:\/\/\/plurnk\//);
    for (const tool of ALL_CORE_OPERATION_TOOLS) {
        assert.ok(indexDoc.content.includes(`plurnk.${tool.target}(`), `mcp:///plurnk.md includes ${tool.target}`);
        const schemaDoc = rendered.find(({ scheme, pathname }) => scheme === "mcp" && pathname === `/plurnk/${tool.target}.json`);
        assert.ok(schemaDoc, `mcp:///plurnk/${tool.target}.json is materialized`);
        const parsedSchema = JSON.parse(schemaDoc.content) as { title: string; description: string };
        assert.equal(parsedSchema.title, `plurnk: ${tool.target}`);
        const examplesSection = (tool.details ?? "").split("## Examples\n\n")[1] ?? "";
        const parsed = PlurnkParser.parseStatements(examplesSection);
        assert.equal(parsed.unparsedTail, undefined, `${tool.target}: ${examplesSection}`);
        const errors = parsed.items.filter((item) => item.kind === "error");
        assert.deepEqual(errors, [], `${tool.target} example parses cleanly: ${examplesSection}`);
        const statements = parsed.items.filter((item) => item.kind === "statement");
        assert.ok(statements.length > 0, `${tool.target} carries at least one Code Mode example`);
    }
});
});
