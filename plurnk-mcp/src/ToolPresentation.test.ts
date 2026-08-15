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

test("{§mcp-tool-presentation} derives Registry rows and standard pull docs from the same enabled tools", () => {
    const tools: Tool[] = [{
        name: "issue_read",
        title: "Issue",
        description: "Read\n one issue.",
        annotations: { title: "Issue reader" },
        inputSchema: {
            type: "object",
            properties: {
                owner: { type: "string" },
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
        invocation: {
            body: { role: "JSON arguments", required: true },
            target: { role: "Read one issue.", required: true, kind: "literal" },
            signature: '{"owner": string, "issue_number": integer}',
        },
    }]);
    assert.match(registry.documentation, /^# gitea$/m);
    assert.match(registry.documentation, /^## issue_read$/m);
    assert.match(registry.documentation, /^### Input schema$/m);
    assert.match(registry.documentation, /^### Output schema$/m);
    assert.match(registry.documentation, /"required": \[/);
    assert.doesNotMatch(registry.documentation, /tool_name|"value"/);
});

test("{§mcp-tool-presentation} an empty enabled set exposes no hidden tool names", () => {
    assert.deepEqual(toolRegistry("gitea", []), {
        tools: [],
        documentation: "",
    });
});
