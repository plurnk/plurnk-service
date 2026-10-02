import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/client";
import { toolRegistry } from "./ToolPresentation.ts";

test("{§mcp-tool-presentation} derives exact summaries and invocations from the same enabled tools", () => {
    const tools: Tool[] = [{
        name: "issue_read",
        title: "Issue",
        description: "Read\n one issue.",
        annotations: { title: "Issue reader" },
        inputSchema: {
            type: "object",
            properties: {
                owner: { type: "string", description: "Repository owner.", minLength: 1 },
                issue_number: { type: "integer" },
            },
            required: ["owner", "issue_number"],
        },
        outputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
        },
    }];
    const registry = toolRegistry("gitea", tools);
    assert.deepEqual(registry.tools, [{
        target: "issue_read",
        summary: "Read one issue.",
        invocation: {
            body: { role: "JSON arguments", required: true },
            target: { role: "MCP tool", required: true, kind: "literal" },
            inputSchema: tools[0]!.inputSchema,
        },
        details: tools[0]!.description,
        definition: tools[0],
    }]);
});

test("{§mcp-summary-derivation} tool purpose precedes titles; blank values fall through in protocol title order", () => {
    const tool = { name: "web_search", inputSchema: { type: "object" as const } };
    const summary = (fields: Partial<Tool>) => toolRegistry("search", [{ ...tool, ...fields }]).tools[0]!.summary;
    assert.equal(summary({ description: "Search the Web. Return matching pages.", title: "Search", annotations: { title: "Old title" } }), "Search the Web.");
    assert.equal(summary({ description: " \n ", title: "Search", annotations: { title: "Old title" } }), "Search");
    assert.equal(summary({ title: " \t ", annotations: { title: "Search title" } }), "Search title");
    assert.equal(summary({ description: " ", title: "", annotations: { title: " " } }), "web_search");
});

test("{§mcp-tool-presentation} an empty enabled set exposes no hidden tool names", () => {
    assert.deepEqual(toolRegistry("gitea", []), {
        tools: [],
    });
});

test("{§mcp-tool-presentation} missing remote prose falls back to the tool name", () => {
    assert.equal(toolRegistry("gitea", [{
        name: "issue_read",
        inputSchema: { type: "object" },
    }]).tools[0]?.summary, "issue_read");
});

test("{§mcp-tool-presentation} a long description trims to its first sentence", () => {
    const tools: Tool[] = [{
        name: "web_search",
        description: "Performs web searches using the API and returns results. Extra detail beyond the first sentence.",
        inputSchema: { type: "object" },
    }];
    assert.equal(
        toolRegistry("brave", tools).tools[0]?.summary,
        "Performs web searches using the API and returns results.",
    );
    assert.equal(toolRegistry("brave", tools).tools[0]?.details, tools[0]!.description,
        "summary shortening does not discard the full description from the input document");
});

test("{§mcp-apps-exclusion} Apps metadata remains inert catalog data, absent from compact invocations", () => {
    const tools: Tool[] = [{
        name: "analytics",
        description: "Interactive analytics.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        _meta: {
            ui: {
                resourceUri: "ui://apps/analytics",
                csp: "default-src 'none'",
                permissions: ["tools/call", "sendOpenLink"],
            },
        },
    }];
    const registry = toolRegistry("apps", tools);
    const entry = registry.tools.find((candidate) => candidate.target === "analytics");
    assert.ok(entry);
    assert.equal(entry.summary, "Interactive analytics.");
    assert.ok(
        !JSON.stringify([entry.summary, entry.invocation]).includes("ui://"),
        "no UI resource or policy material reaches the compact invocation",
    );
    assert.deepEqual(entry.definition, tools[0], "the on-demand definition is not rewritten or stripped");
});

test("{§mcp-tool-presentation} catalogs preserve complete original tool records in name order", () => {
    const tools: Tool[] = [{
        name: "search", title: "Search", description: "Search documents.\n\nAll constraints apply.",
        inputSchema: { type: "object", properties: { query: { $ref: "#/$defs/query" } },
            $defs: { query: { type: "string", minLength: 1 } } },
        outputSchema: { type: "object", properties: { matches: { type: "array", items: { type: "string" } } } },
        annotations: { readOnlyHint: true },
        icons: [{ src: "https://example.invalid/search.svg", mimeType: "image/svg+xml" }],
        _meta: { vendor: { revision: 2 } },
    }, {
        name: "list", inputSchema: { type: "object", additionalProperties: false },
    }];
    const before = structuredClone(tools);
    const registry = toolRegistry("docs", tools);
    assert.deepEqual(registry.tools.map(({ definition }) => definition), [tools[1], tools[0]]);
    assert.deepEqual(tools, before, "presentation does not mutate the received catalog");
});
