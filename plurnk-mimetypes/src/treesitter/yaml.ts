import { treeSitterSpan } from "../ParserCoordinates.ts";
import MimetypeInputError from "../MimetypeInputError.ts";
import type { TreeSitterSymbolProjection } from "../ParserCoordinates.ts";
import type { SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// YAML symbol mapping ({§mimetype-symbol}) via @tree-sitter-grammars/tree-sitter-yaml.
//
// Two channels:
//   - symbols (extract): tree-sitter walk surfacing every mapping key as a
//     field-like outline entry. Coarse but useful for the model's preview.
//   - deep-json (deepJson): the parsed YAML value via the `yaml` library —
//     this is the jsonpath query target. Users writing `$.server.host`
//     expect the parsed value tree, not the AST. The framework projects
//     this to deep-xml.
export async function deepJson(content: string): Promise<unknown> {
    const { parse, YAMLParseError } = await import("yaml" as string) as {
        parse(text: string): unknown;
        YAMLParseError: new (...args: never[]) => Error;
    };
    try {
        const value = parse(content);
        return value ?? null;
    } catch (cause) {
        if (cause instanceof YAMLParseError || isYamlContentLimit(cause)) {
            throw new MimetypeInputError({ mimetype: "application/yaml", cause });
        }
        throw cause;
    }
}

// `yaml` reports alias-order and alias-expansion input limits with built-in
// ReferenceError rather than YAMLParseError. Match only its documented source
// conditions; an unrelated ReferenceError remains an implementation defect.
function isYamlContentLimit(cause: unknown): boolean {
    if (!(cause instanceof ReferenceError)) return false;
    return cause.message.startsWith("Unresolved alias ")
        || cause.message.startsWith("Excessive alias count ");
}

export function extract(root: TreeSitterNode, _content: string): TreeSitterSymbolProjection[] {
    const out: TreeSitterSymbolProjection[] = [];
    walk(root, out, "");
    return out;
}

function walk(node: TreeSitterNode, out: TreeSitterSymbolProjection[], container: string): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "block_mapping_pair" || child.type === "flow_pair") {
            handlePair(child, out, container);
            continue;
        }
        walk(child, out, container);
    }
}

function handlePair(pair: TreeSitterNode, out: TreeSitterSymbolProjection[], container: string): void {
    const key = pair.childForFieldName("key");
    if (!key) return;
    const keyText = scalarText(key);
    if (keyText) push(out, "field", keyText, pair, container);
    const value = pair.childForFieldName("value");
    if (!value) return;
    // Keys emitted inside this pair's value carry the dotted path of
    // enclosing emitted keys.
    const inner = keyText
        ? (container.length > 0 ? `${container}.${keyText}` : keyText)
        : container;
    walk(value, out, inner);
}

function scalarText(node: TreeSitterNode): string | null {
    // key is typically a flow_node → plain_scalar → string_scalar
    if (node.type === "string_scalar" || node.type === "plain_scalar") {
        return node.text;
    }
    if (node.type === "flow_node") {
        const inner = node.namedChild(0);
        if (inner) return scalarText(inner);
    }
    // Fallback: source text — strip surrounding quotes if any.
    const text = node.text;
    return text.replace(/^['"]|['"]$/g, "");
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
