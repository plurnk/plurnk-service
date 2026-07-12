import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Scala SPEC §3 mapping via tree-sitter-scala.
//
//   package_clause       → module
//   class_definition     → class (recurse, inClass=true)
//   object_definition    → class (singleton)
//   trait_definition     → interface
//   enum_definition      → enum
//   function_definition  → function/method
//   function_declaration → function/method (abstract)
//   val_definition       → constant (or field in class)
//   var_definition       → variable (or field in class)
//   type_definition      → type
//
// Container semantics (issue #18): members carry the dotted path of enclosing
// emitted class/object/trait/enum/package names. Top-level symbols carry no
// container. Package blocks (`package foo { ... }`) contribute to the
// container path but are NOT class scope — defs/vals inside stay
// function/constant — so classness travels as a separate flag; container
// presence alone can't distinguish package bodies from template bodies.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, "", /*inClass*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], container: string, inClass: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, container, inClass);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], container: string, inClass: boolean): void {
    switch (node.type) {
        case "package_clause": {
            const name = childFieldText(node, "name") ?? firstIdentifierText(node);
            if (name) push(out, "module", name, node, container);
            // package_clause may have a body containing further definitions.
            const body = node.childForFieldName("body");
            if (body) walk(body, out, name ? qualify(container, name) : container, false);
            return;
        }
        case "class_definition":
        case "object_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "class", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, qualify(container, name), true);
            return;
        }
        case "trait_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "interface", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, qualify(container, name), true);
            return;
        }
        case "enum_definition": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, name ? qualify(container, name) : container, true);
            return;
        }
        case "function_definition":
        case "function_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: inClass ? "method" : "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "val_definition":
        case "val_declaration": {
            const name = patternName(node.childForFieldName("pattern"))
                ?? childFieldText(node, "name");
            if (!name) return;
            const kind: SymbolKind = inClass ? "field" : "constant";
            push(out, kind, name, node, container);
            return;
        }
        case "var_definition":
        case "var_declaration": {
            const name = patternName(node.childForFieldName("pattern"))
                ?? childFieldText(node, "name");
            if (!name) return;
            const kind: SymbolKind = inClass ? "field" : "variable";
            push(out, kind, name, node, container);
            return;
        }
        case "type_definition": {
            const name = childFieldText(node, "name");
            if (name) push(out, "type", name, node, container);
            return;
        }
        default:
            return;
    }
}

function qualify(container: string, name: string): string {
    return container.length > 0 ? `${container}.${name}` : name;
}

function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
}

function patternName(node: TreeSitterNode | null): string | null {
    if (!node) return null;
    if (node.type === "identifier" || node.type === "stable_identifier") return node.text;
    return firstIdentifierText(node);
}

function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    return child ? child.text : null;
}

function firstIdentifierText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier" || child.type === "stable_identifier") return child.text;
    }
    return null;
}

function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        if (child.type === "parameter" || child.type === "class_parameter") {
            const name = childFieldText(child, "name") ?? firstIdentifierText(child);
            if (name) out.push(name);
        }
    }
    return out;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container: string): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}

export { refsQuery } from "./queries/scala.ts";
