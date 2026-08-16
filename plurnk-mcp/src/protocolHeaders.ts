import type { Tool } from "@modelcontextprotocol/client";

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_TYPES = new Set(["string", "integer", "number", "boolean"]);

const requiresEncoding = (value: string): boolean => {
    if (value.length === 0 || value !== value.trim()) return true;
    if (value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX)) return true;
    for (let index = 0; index < value.length; index += 1) {
        const codePoint = value.codePointAt(index);
        if (codePoint === 9 || (codePoint !== undefined && codePoint >= 32 && codePoint <= 126)) {
            continue;
        }
        return true;
    }
    return false;
};

export const mcpRoutingHeaderValue = (value: string): string => requiresEncoding(value)
    ? `${BASE64_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SUFFIX}`
    : value;

interface HeaderDeclaration {
    readonly name: string;
    readonly path: readonly string[];
    readonly type: string;
}

const headerDeclarations = (tool: Tool): HeaderDeclaration[] => {
    const declarations: HeaderDeclaration[] = [];
    const seen = new Set<string>();
    const visit = (schema: unknown, path: readonly string[]): void => {
        if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
        const node = schema as Record<string, unknown>;
        const header = node["x-mcp-header"];
        if (header !== undefined) {
            if (
                path.length === 0
                || typeof header !== "string"
                || !RFC9110_TOKEN.test(header)
                || typeof node.type !== "string"
                || !HEADER_TYPES.has(node.type)
            ) {
                throw new Error(`MCP tool '${tool.name}' has an invalid x-mcp-header declaration.`);
            }
            const folded = header.toLowerCase();
            if (seen.has(folded)) {
                throw new Error(`MCP tool '${tool.name}' repeats x-mcp-header '${header}'.`);
            }
            seen.add(folded);
            declarations.push({ name: header, path, type: node.type });
        }
        const properties = node.properties;
        if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return;
        for (const [name, child] of Object.entries(properties)) {
            visit(child, [...path, name]);
        }
    };
    visit(tool.inputSchema, []);
    return declarations;
};

const valueAt = (root: Record<string, unknown>, path: readonly string[]): unknown => {
    let value: unknown = root;
    for (const segment of path) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
};

const primitiveHeaderValue = (value: unknown, type: string): string | undefined => {
    if (type === "string") return typeof value === "string" ? value : undefined;
    if (type === "boolean") return typeof value === "boolean" ? String(value) : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
    if (type === "integer" && (!Number.isSafeInteger(value) || !Number.isInteger(value))) {
        return undefined;
    }
    return String(value);
};

export const mcpParamHeaders = (
    tool: Tool,
    args: Record<string, unknown>,
): Readonly<Record<string, string>> => Object.fromEntries(
    headerDeclarations(tool).flatMap((declaration) => {
        const value = valueAt(args, declaration.path);
        if (value === undefined || value === null) return [];
        const primitive = primitiveHeaderValue(value, declaration.type);
        return primitive === undefined
            ? []
            : [[`Mcp-Param-${declaration.name}`, mcpRoutingHeaderValue(primitive)]];
    }),
);
