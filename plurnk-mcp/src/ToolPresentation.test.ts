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
        summary: "Read one issue.",
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

test("{§mcp-tool-presentation} missing remote prose gets a factual fallback", () => {
    assert.equal(toolRegistry("gitea", [{
        name: "issue_read",
        inputSchema: { type: "object" },
    }]).tools[0]?.summary, "Invoke the issue_read tool exposed by the gitea MCP server.");
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
