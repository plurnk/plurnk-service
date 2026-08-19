import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/client";
import { inputSignature, toolRegistry } from "./ToolPresentation.ts";

test("{§mcp-tool-presentation} renders deterministic JSON-shaped signatures without fake values", () => {
    const schema = {
        type: "object",
        properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            issue_number: { type: "integer" },
            method: { enum: ["get", "get_comments", "get_labels"] },
            page: { anyOf: [{ type: "integer" }, { type: "null" }] },
            filter: {
                type: "object",
                properties: {
                    labels: { type: "array", items: { type: "string" } },
                },
                required: ["labels"],
            },
        },
        required: ["owner", "repo", "issue_number", "method"],
    };
    assert.equal(
        inputSignature(schema),
        '{"owner": string, "repo": string, "issue_number": integer, "method": "get" | "get_comments" | "get_labels", "page"?: integer | null, "filter"?: {"labels": [string]}}',
    );
});

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
        summary: "Issue reader",
        invocation: {
            body: { role: "JSON arguments", required: true },
            target: { role: "MCP tool", required: true, kind: "literal" },
            signature: '{"owner": string, "issue_number": integer}',
        },
        details: [
            "## Inputs",
            "",
            "| Property | Required | Contract | Description |",
            "| --- | --- | --- | --- |",
            "| `owner` | yes | `string; minLength=1` | Repository owner. |",
            "| `issue_number` | yes | `integer` |  |",
        ].join("\n"),
    }]);
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

test("{§mcp-tool-presentation} an authored _SUMMARY override beats every derived tier", () => {
    const tools: Tool[] = [{
        name: "issue_read",
        title: "Issue",
        description: "Read one issue.",
        annotations: { title: "Issue reader" },
        inputSchema: { type: "object" },
    }];
    assert.equal(
        toolRegistry("gitea", tools, new Map([["gitea/issue_read", "Read one issue."]])).tools[0]?.summary,
        "Read one issue.",
    );
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
});

test("{§mcp-apps-exclusion} Apps UI metadata never leaks into the model-facing projection", () => {
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
        "no UI resource or policy material reaches the projection",
    );
});
