import type { RuntimeToolRegistry } from "@plurnk/plurnk-execs";
import type { Tool } from "@modelcontextprotocol/client";

type JsonObject = Readonly<Record<string, unknown>>;

const objectOf = (value: unknown): JsonObject | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as JsonObject
        : null;

const literal = (value: unknown): string => JSON.stringify(value) ?? "unknown";

const inlineCode = (value: string): string => {
    const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
    const marker = "`".repeat(longest + 1);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${marker}${padding}${value}${padding}${marker}`;
};

const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();

const localReference = (root: JsonObject, reference: string): unknown => {
    if (!reference.startsWith("#/")) return undefined;
    let value: unknown = root;
    for (const encoded of reference.slice(2).split("/")) {
        const current = objectOf(value);
        if (current === null) return undefined;
        const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        value = current[key];
    }
    return value;
};

const schemaType = (
    value: unknown,
    root: JsonObject,
    references: ReadonlySet<string> = new Set(),
): string => {
    const schema = objectOf(value);
    if (schema === null) return "unknown";
    if ("const" in schema) return literal(schema.const);
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map(literal).join(" | ");
    }
    for (const union of ["oneOf", "anyOf"] as const) {
        const choices = schema[union];
        if (Array.isArray(choices) && choices.length > 0) {
            return choices.map((choice) => schemaType(choice, root, references)).join(" | ");
        }
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
        return schema.allOf.map((choice) => schemaType(choice, root, references)).join(" & ");
    }
    if (typeof schema.$ref === "string") {
        if (references.has(schema.$ref)) return "unknown";
        const resolved = localReference(root, schema.$ref);
        return resolved === undefined
            ? "unknown"
            : schemaType(resolved, root, new Set([...references, schema.$ref]));
    }
    if (Array.isArray(schema.type)) {
        return schema.type.map((type) => schemaType({ ...schema, type }, root, references)).join(" | ");
    }
    const type = schema.type;
    if (type === "object" || schema.properties !== undefined) {
        const properties = objectOf(schema.properties) ?? {};
        const required = new Set(
            Array.isArray(schema.required)
                ? schema.required.filter((name): name is string => typeof name === "string")
                : [],
        );
        const fields = Object.entries(properties).map(([name, property]) =>
            `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(property, root, references)}`);
        return `{${fields.join(", ")}}`;
    }
    if (type === "array") return `[${schemaType(schema.items, root, references)}]`;
    if (type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "null") {
        return type;
    }
    return "unknown";
};

export const inputSignature = (inputSchema: unknown): string => {
    const root = objectOf(inputSchema);
    return root === null ? "unknown" : schemaType(root, root);
};

const detailType = (value: unknown, root: JsonObject, references: ReadonlySet<string> = new Set()): string => {
    const schema = objectOf(value);
    if (schema === null) return "unknown";
    if ("const" in schema || Array.isArray(schema.enum)) return schemaType(schema, root, references);
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
        if (Array.isArray(schema[union])) return schemaType(schema, root, references);
    }
    if (typeof schema.$ref === "string") {
        if (references.has(schema.$ref)) return "unknown";
        const resolved = localReference(root, schema.$ref);
        return resolved === undefined
            ? "unknown"
            : detailType(resolved, root, new Set([...references, schema.$ref]));
    }
    if (Array.isArray(schema.type)) {
        return schema.type.map((type) => detailType({ ...schema, type }, root, references)).join(" | ");
    }
    if (schema.type === "object" || schema.properties !== undefined) return "object";
    if (schema.type === "array") return `${detailType(schema.items, root, references)}[]`;
    return typeof schema.type === "string" ? schema.type : "unknown";
};

const constraintText = (value: unknown, root: JsonObject): string => {
    const schema = objectOf(value) ?? {};
    const parts = [detailType(schema, root)];
    for (const key of [
        "format",
        "default",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minLength",
        "maxLength",
        "pattern",
        "minItems",
        "maxItems",
        "uniqueItems",
    ] as const) {
        if (schema[key] !== undefined) parts.push(`${key}=${literal(schema[key])}`);
    }
    return parts.join("; ");
};

interface InputDetailRow {
    readonly property: string;
    readonly required: boolean;
    readonly contract: string;
    readonly description: string;
}

const inputRows = (
    value: unknown,
    root: JsonObject,
    prefix = "",
    references: ReadonlySet<string> = new Set(),
): InputDetailRow[] => {
    const schema = objectOf(value);
    if (schema === null) return [];
    if (typeof schema.$ref === "string") {
        if (references.has(schema.$ref)) return [];
        const resolved = localReference(root, schema.$ref);
        if (resolved === undefined) return [];
        return inputRows(resolved, root, prefix, new Set([...references, schema.$ref]));
    }
    const properties = objectOf(schema.properties) ?? {};
    const required = new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((name): name is string => typeof name === "string")
            : [],
    );
    return Object.entries(properties).flatMap(([name, property]): InputDetailRow[] => {
        const path = prefix === "" ? name : `${prefix}.${name}`;
        const propertySchema = objectOf(property) ?? {};
        const description = typeof propertySchema.description === "string"
            ? escapeCell(propertySchema.description)
            : "";
        const row: InputDetailRow = {
            property: path,
            required: required.has(name),
            contract: constraintText(property, root),
            description,
        };
        const nested = propertySchema.type === "array"
            ? inputRows(propertySchema.items, root, `${path}[]`, references)
            : inputRows(property, root, path, references);
        return [row, ...nested];
    });
};

export const inputDetails = (inputSchema: unknown): string => {
    const root = objectOf(inputSchema);
    if (root === null) return "";
    const rows = inputRows(root, root);
    if (rows.length === 0) return "";
    return [
        "## Inputs",
        "",
        "| Property | Required | Contract | Description |",
        "| --- | --- | --- | --- |",
        ...rows.map((row) => `| ${inlineCode(row.property)} | ${row.required ? "yes" : "no"} | ${inlineCode(row.contract)} | ${row.description} |`),
    ].join("\n");
};

const summaryOf = (server: string, tool: Tool): string => {
    const authored = tool.description ?? tool.annotations?.title ?? tool.title;
    if (authored === undefined) {
        return `Invoke the ${tool.name} tool exposed by the ${server} MCP server.`;
    }
    const normalized = authored.replaceAll(/\s+/gu, " ").trim();
    return normalized === ""
        ? `Invoke the ${tool.name} tool exposed by the ${server} MCP server.`
        : normalized;
};

export const toolRegistry = (server: string, source: readonly Tool[]): RuntimeToolRegistry => {
    const tools = source.toSorted((left, right) => left.name.localeCompare(right.name));
    return {
        tools: tools.map((tool) => {
            const details = inputDetails(tool.inputSchema);
            return {
                target: tool.name,
                summary: summaryOf(server, tool),
                invocation: {
                    body: {
                        role: "JSON arguments",
                        required: Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0,
                    },
                    target: {
                        role: "MCP tool",
                        required: true,
                        kind: "literal",
                    },
                    signature: inputSignature(tool.inputSchema),
                },
                ...(details === "" ? {} : { details }),
            };
        }),
    };
};
