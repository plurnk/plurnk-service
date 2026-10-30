import assert from "node:assert/strict";
import test from "node:test";
import { Validator, type JsonSchema } from "@plurnk/plurnk-contracts";
import ToolInputSchema from "./ToolInputSchema.ts";

test("{§executor-discovery} a required closed set of strings previews its first value and lists bounded choices in the aside (#762, #1228)", () => {
    const issueRead = {
        type: "object",
        required: ["method", "owner", "issue_number"],
        properties: {
            method: { type: "string", enum: ["get", "get_comments", "get_labels"] },
            owner: { type: "string" },
            issue_number: { type: "number" },
        },
    };
    assert.equal(ToolInputSchema.preview(issueRead), '{"method": "get", "owner": "", "issue_number": 0}');
    assert.equal(ToolInputSchema.asideNote(issueRead), '(method: "get"|"get_comments"|"get_labels")');

    const oversizedOrMixed = {
        type: "object", required: ["a", "b", "c", "d", "e", "f"],
        properties: {
            a: { type: "string", enum: Array.from({ length: 13 }, (_, i) => `v${i}`) },
            b: { type: "string", enum: ["x", 1] },
            c: { type: "boolean" },
            d: { type: "array" },
            e: { type: "object" },
            f: {},
        },
    };
    assert.equal(ToolInputSchema.preview(oversizedOrMixed), '{"a": "v0", "b": "x", "c": false, "d": [], "e": {}, "f": null}');
    assert.equal(ToolInputSchema.asideNote(oversizedOrMixed), undefined);
});

test("{§executor-discovery} a schema that requires one of several inputs previews its first branch", () => {
    const oneOf = {
        type: "object", additionalProperties: false,
        properties: { source: { type: "string" }, configuration: { type: "object" } },
        anyOf: [{ required: ["source"] }, { required: ["configuration"] }],
    };
    assert.equal(ToolInputSchema.preview(oneOf), '{"source": ""}');
    assert.deepEqual(ToolInputSchema.requiredFields(oneOf), ["source"]);
    assert.equal(ToolInputSchema.asideNote(oneOf), "(configuration?: object)");
    assert.deepEqual(ToolInputSchema.requiredFields({ type: "object", required: ["a"], anyOf: [{ required: ["a", "b"] }] }), ["a", "b"]);
});

test("{§executor-discovery} surfaces optional properties, nested object/array shapes, and bounded tails (#1228)", () => {
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
        ToolInputSchema.asideNote(fillForm),
        '(fields: {target: string, name: string, type: "textbox"|"checkbox"|"radio"|"combobox"|"slider", value: string, element?: string}[])',
    );
    assert.equal(
        ToolInputSchema.fence("browser", {
            body: { role: "JSON arguments", required: true },
            target: { role: "MCP tool", required: true, kind: "literal" },
            inputSchema: fillForm,
        }, { exactTarget: "browser_fill_form", aside: "-> Fill form --", schemaPath: "mcp:///browser/browser_fill_form.json" }),
        '```browser (browser_fill_form) <!-- Description: -> Fill form — (fields: {target: string, name: string, type: "textbox"|"checkbox"|"radio"|"combobox"|"slider", value: string, element?: string}[]) Schema: mcp:///browser/browser_fill_form.json -->\n{"fields": []}\n```',
    );

    const manyOptionalProps = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`opt${i}`, { type: "string" }]));
    const capped = ToolInputSchema.asideNote({ type: "object", properties: manyOptionalProps });
    assert.ok(capped?.endsWith(", … +2 opt)"), `expected bounded optional tail, got ${capped}`);

    assert.equal(
        ToolInputSchema.asideNote({
            type: "object",
            required: ["mode"],
            properties: {
                mode: { type: "string", enum: ["list", "add"] },
                alias: { type: "string" },
                definition: { $ref: "https://schemas.plurnk.xyz/v0/McpServerDefinition.json" },
                selector: { $ref: "#/$defs/selector" },
            },
            $defs: { selector: { oneOf: [{ type: "string" }, { type: "integer" }] } },
        }),
        '(mode: "list"|"add"; alias?: string, definition?: {type: "stdio", command: string, args?: string[], env?: object, cwd?: string, plurnkWorkspace?: string|string[], … +1 opt}|{type: "streamable-http", url: string, headers?: object, authorization?: object, plurnkWorkspace?: string|string[], plurnkSession?: string}, selector?: any)',
    );

    const topLevelUnion = Validator.schemaByRef("https://schemas.plurnk.xyz/v0/McpServerDefinition.json") as JsonSchema;
    assert.equal(ToolInputSchema.preview(topLevelUnion), '{"type": "stdio", "command": ""}');
    assert.equal(
        ToolInputSchema.asideNote(topLevelUnion),
        '({type: "stdio", command: string, args?: string[], env?: object, cwd?: string, plurnkWorkspace?: string|string[], … +1 opt}|{type: "streamable-http", url: string, headers?: object, authorization?: object, plurnkWorkspace?: string|string[], plurnkSession?: string})',
    );
});

test("{§executor-discovery} targetSegment encodes reserved URI characters and references resolves repository schemas", () => {
    assert.equal(ToolInputSchema.targetSegment("issue/read(1)!"), "issue%2Fread%281%29%21");
    const ref = "https://schemas.plurnk.xyz/v0/McpServerDefinition.json";
    const schema = {
        $id: "https://example.com/root.json",
        type: "object",
        properties: {
            definition: { $ref: ref },
            external: { $ref: "https://not-a-server.invalid/schema.json" },
        },
    };
    assert.deepEqual(ToolInputSchema.references(schema), [
        Validator.schemaByRef(ref),
        Validator.schemaByRef("https://schemas.plurnk.xyz/v0/McpOAuth.json"),
    ]);
});
