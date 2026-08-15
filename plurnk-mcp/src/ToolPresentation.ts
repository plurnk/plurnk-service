import type { RuntimeToolRegistry } from "@plurnk/plurnk-execs";
import type { Tool } from "@modelcontextprotocol/client";

type JsonObject = Readonly<Record<string, unknown>>;

const objectOf = (value: unknown): JsonObject | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as JsonObject
        : null;

const literal = (value: unknown): string => JSON.stringify(value) ?? "unknown";

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

const roleOf = (tool: Tool): string => {
    const authored = tool.description ?? tool.annotations?.title ?? tool.title;
    if (authored === undefined) return "MCP tool";
    const normalized = authored.replaceAll(/\s+/gu, " ").trim();
    return normalized === "" ? "MCP tool" : normalized;
};

const inlineCode = (value: string): string => {
    const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${value}${padding}${fence}`;
};

const documentation = (server: string, tools: readonly Tool[]): string => {
    if (tools.length === 0) return "";
    const sections = tools.flatMap((tool) => [
        `## ${tool.name}`,
        "",
        ...(tool.description === undefined ? [] : [tool.description.trim(), ""]),
        `Invocation: ${inlineCode(inputSignature(tool.inputSchema))}`,
        "",
        "### Input schema",
        "",
        "```json",
        JSON.stringify(tool.inputSchema, null, 2),
        "```",
        ...(tool.outputSchema === undefined
            ? []
            : [
                "",
                "### Output schema",
                "",
                "```json",
                JSON.stringify(tool.outputSchema, null, 2),
                "```",
            ]),
    ]);
    return [
        `# ${server}`,
        "",
        "Enabled MCP tool contracts.",
        "",
        ...sections,
    ].join("\n");
};

export const toolRegistry = (server: string, source: readonly Tool[]): RuntimeToolRegistry => {
    const tools = source.toSorted((left, right) => left.name.localeCompare(right.name));
    return {
        tools: tools.map((tool) => ({
            target: tool.name,
            invocation: {
                body: {
                    role: "JSON arguments",
                    required: Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0,
                },
                target: {
                    role: roleOf(tool),
                    required: true,
                    kind: "literal",
                },
                signature: inputSignature(tool.inputSchema),
            },
        })),
        documentation: documentation(server, tools),
    };
};
