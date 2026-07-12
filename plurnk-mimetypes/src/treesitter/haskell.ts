import type { MimeSymbol } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Haskell SPEC §3 mapping via tree-sitter-haskell.
//
//   header → module                       module name → module
//   data_type                             → class (Haskell data types are
//                                            the structural "thing");
//                                            data constructors not surfaced
//   newtype                               → class
//   type_synomym (sic; grammar spelling)  → type
//   class                                 → interface (type classes are
//                                            Haskell's interface concept);
//                                            class method signatures surface
//                                            as method
//   signature                             → function (top-level type sig
//                                            is the canonical declaration
//                                            site; the matching `function`
//                                            equation nodes are the body —
//                                            deduped, but the def's span
//                                            extends to the last equation
//                                            so body refs join, issue #22)
//   function                              → function (when no preceding
//                                            signature; we dedup by name)
//   instance                              → not surfaced as its own symbol
//                                            (it implements a class for a
//                                            specific type; methods inside
//                                            an instance body could
//                                            optionally surface)
//   import                                → excluded
//
// Container semantics (issue #18): module-level declarations are flat (the
// header module is a sibling, not a structural parent). Only class-body
// method signatures carry a container — the type class name.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    const emittedFns = new Set<string>();

    // Module header
    const header = findFirstNamedChild(root, "header");
    if (header) {
        const mod = findFirstNamedChild(header, "module");
        const modId = mod ? findFirstNamedChild(mod, "module_id") : null;
        if (modId) {
            out.push({
                name: modId.text,
                kind: "module",
                ...position(modId),
            });
        }
    }

    const decls = findFirstNamedChild(root, "declarations");
    if (!decls) return out;

    for (let i = 0; i < decls.namedChildCount; i += 1) {
        const node = decls.namedChild(i);
        if (!node) continue;
        switch (node.type) {
            case "data_type":
            case "newtype": {
                const name = findFirstNamedChild(node, "name");
                if (name) push(out, "class", name.text, node, "");
                break;
            }
            case "type_synomym": {
                const name = findFirstNamedChild(node, "name");
                if (name) push(out, "type", name.text, node, "");
                break;
            }
            case "class": {
                const name = findFirstNamedChild(node, "name");
                if (name) push(out, "interface", name.text, node, "");
                // Class-body signatures become methods, contained by the class.
                const body = findFirstNamedChild(node, "class_declarations");
                if (body) {
                    for (let j = 0; j < body.namedChildCount; j += 1) {
                        const sig = body.namedChild(j);
                        if (!sig || sig.type !== "signature") continue;
                        const v = findFirstNamedChild(sig, "variable");
                        if (v) push(out, "method", v.text, sig, name ? name.text : "");
                    }
                }
                break;
            }
            case "signature":
            case "function": {
                const v = findFirstNamedChild(node, "variable");
                if (!v) break;
                if (emittedFns.has(v.text)) break;
                emittedFns.add(v.text);
                // Issue #22: the def's span must cover the function's body —
                // each equation is a sibling `function` node sharing the
                // variable name, so extend to the last consecutive equation.
                const pos = position(node);
                for (let j = i + 1; j < decls.namedChildCount; j += 1) {
                    const sib = decls.namedChild(j);
                    if (!sib || sib.type !== "function") break;
                    if (findFirstNamedChild(sib, "variable")?.text !== v.text) break;
                    pos.endLine = sib.endPosition.row + 1;
                    pos.endColumn = sib.endPosition.column + 1;
                }
                out.push({ name: v.text, kind: "function", ...pos });
                break;
            }
            default:
                break;
        }
    }

    return out;
}

function findFirstNamedChild(node: TreeSitterNode, type: string): TreeSitterNode | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === type) return child;
    }
    return null;
}

function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
}

function push(
    out: MimeSymbol[],
    kind: "class" | "type" | "interface" | "function" | "method" | "module",
    name: string,
    node: TreeSitterNode,
    container: string,
): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}

export { refsQuery } from "./queries/haskell.ts";
