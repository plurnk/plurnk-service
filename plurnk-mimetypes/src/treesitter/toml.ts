import { treeSitterSpan } from "../ParserCoordinates.ts";
import MimetypeInputError from "../MimetypeInputError.ts";
import type { TreeSitterSymbolProjection } from "../ParserCoordinates.ts";
import type { SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// TOML symbol mapping ({§mimetype-symbol}) via @tree-sitter-grammars/tree-sitter-toml.
//
// Two channels:
//   - symbols (extract): tree-sitter walk surfacing tables/keys as a
//     module/field outline. Coarse, for the model's preview.
//   - deep-json (deepJson): the parsed TOML value via `smol-toml`. This is
//     what jsonpath queries against — users writing `$.server.host` want
//     the parsed value tree.
// smol-toml (1.9+) hands back null-prototype objects; the deep-JSON tree is plain JSON, so every
// table is re-homed on Object and every array walked. Dates and scalars pass through untouched.
const plain = (value: unknown): unknown => Array.isArray(value)
    ? value.map(plain)
    : value !== null && typeof value === "object" && Object.getPrototypeOf(value) === null
        ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]))
        : value;

export async function deepJson(content: string): Promise<unknown> {
    const { parse, TomlError } = await import("smol-toml" as string) as {
        parse(text: string): unknown;
        TomlError: new (...args: never[]) => Error;
    };
    try {
        return plain(parse(content));
    } catch (cause) {
        if (cause instanceof TomlError) {
            throw new MimetypeInputError({ mimetype: "application/toml", cause });
        }
        throw cause;
    }
}

export function extract(root: TreeSitterNode, _content: string): TreeSitterSymbolProjection[] {
    const out: TreeSitterSymbolProjection[] = [];
    for (let i = 0; i < root.namedChildCount; i += 1) {
        const child = root.namedChild(i);
        if (!child) continue;
        dispatch(child, out);
    }
    return out;
}

function dispatch(node: TreeSitterNode, out: TreeSitterSymbolProjection[]): void {
    switch (node.type) {
        case "table":
        case "table_array_element": {
            const key = firstKeyText(node);
            if (key) push(out, "module", key, node, "");
            // Pairs inside the table carry the emitted table name verbatim
            // as their container — dotted headers stay one segment.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "pair") {
                    const pkey = firstKeyText(child);
                    if (pkey) push(out, "field", pkey, child, key ?? "");
                }
            }
            return;
        }
        case "pair": {
            // Top-level pair (before any [table] header).
            const key = firstKeyText(node);
            if (key) push(out, "field", key, node, "");
            return;
        }
        default:
            return;
    }
}

function firstKeyText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "bare_key" || child.type === "dotted_key"
            || child.type === "quoted_key") {
            return child.text.replace(/^['"]|['"]$/g, "");
        }
    }
    return null;
}

function push(
    out: TreeSitterSymbolProjection[],
    kind: SymbolKind,
    name: string,
    node: TreeSitterNode,
    container: string,
): void {
    out.push({
        name,
        kind,
        span: treeSitterSpan(node),
        ...(container.length > 0 && { container }),
    });
}
