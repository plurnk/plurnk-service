import { isRecord } from "@plurnk/plurnk-contracts";
import type { Tool } from "@modelcontextprotocol/client";

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// {§mcp-transports} — the types SEP-2243 admits on a declared property; `number` is not one of them.
const HEADER_TYPES = new Set(["string", "integer", "boolean"]);
// {§mcp-transports} — subschema keywords a declaration must not sit under: the chain to a declared
// property runs through `properties` alone. A map-valued keyword holds schemas as its values.
const UNREACHABLE_KEYWORDS = [
    "items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
    "propertyNames", "patternProperties", "dependentSchemas", "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
    "$defs", "definitions",
] as const;
const MAP_VALUED_KEYWORDS = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);

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

/** {§mcp-transports} — a tool definition whose `x-mcp-header` declarations break SEP-2243; it is never called. */
export class HeaderDeclarationError extends Error {
    readonly tool: string;
    readonly declaration: string;

    constructor(tool: string, declaration: string) {
        super(`MCP tool '${tool}' declares an invalid x-mcp-header: ${declaration}`);
        this.name = "HeaderDeclarationError";
        this.tool = tool;
        this.declaration = declaration;
    }
}

const pathName = (path: readonly string[]): string => path.length === 0 ? "(root)" : path.join(".");

// {§mcp-transports} — every declaration the schema carries, or the first one that breaks the contract.
const headerDeclarations = (tool: Tool): HeaderDeclaration[] => {
    const declarations: HeaderDeclaration[] = [];
    const seen = new Map<string, string>();
    function refuse(path: readonly string[], what: string): never {
        throw new HeaderDeclarationError(tool.name, `${pathName(path)}: ${what}`);
    }
    const visit = (schema: unknown, path: readonly string[], reachable: boolean): void => {
        if (!isRecord(schema)) return;
        const node = schema;
        if ("x-mcp-header" in node) {
            if (!reachable || path.length === 0) refuse(path, "x-mcp-header outside a chain of properties");
            const header = node["x-mcp-header"];
            if (typeof header !== "string" || header.length === 0) refuse(path, "x-mcp-header is not a non-empty string");
            if (!RFC9110_TOKEN.test(header)) refuse(path, `x-mcp-header '${header}' is not an RFC 9110 token`);
            const type = typeof node.type === "string" ? node.type : undefined;
            if (type === undefined || !HEADER_TYPES.has(type)) {
                refuse(path, `x-mcp-header '${header}' on type ${type ?? "(none)"}; permitted on string, integer and boolean`);
            }
            const folded = header.toLowerCase();
            const prior = seen.get(folded);
            if (prior !== undefined) refuse(path, `x-mcp-header '${header}' repeats '${prior}'`);
            seen.set(folded, header);
            declarations.push({ name: header, path, type });
        }
        const properties = node.properties;
        if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
            for (const [name, child] of Object.entries(properties)) visit(child, [...path, name], reachable);
        }
        for (const keyword of UNREACHABLE_KEYWORDS) {
            const sub = node[keyword];
            if (sub === undefined) continue;
            const branches = Array.isArray(sub)
                ? sub
                : sub !== null && typeof sub === "object" && MAP_VALUED_KEYWORDS.has(keyword) ? Object.values(sub) : [sub];
            for (const branch of branches) visit(branch, [...path, `<${keyword}>`], false);
        }
    };
    visit(tool.inputSchema, [], true);
    return declarations;
};

/** {§mcp-transports} — refuses before any request leg; the definition is scanned, nothing is sent. */
export const assertHeaderDeclarations = (tool: Tool): void => {
    headerDeclarations(tool);
};

const valueAt = (root: Record<string, unknown>, path: readonly string[]): unknown => {
    let value: unknown = root;
    for (const segment of path) {
        if (!isRecord(value)) return undefined;
        value = value[segment];
    }
    return value;
};

const primitiveHeaderValue = (value: unknown, type: string): string | undefined => {
    if (type === "string") return typeof value === "string" ? value : undefined;
    if (type === "boolean") return typeof value === "boolean" ? String(value) : undefined;
    return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
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
