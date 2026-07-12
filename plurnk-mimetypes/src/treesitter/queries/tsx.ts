import { refsQuery as typescriptRefsQuery } from "./typescript.ts";

// References query for tree-sitter-tsx (issue #19; SPEC §16). The tsx grammar is
// the typescript grammar plus JSX, so this is the typescript query (imports,
// calls, instantiations, inherit, types — identical node names) PLUS JSX
// component instantiation:
//
//   <Button/> / <Icon> → instantiate. A JSX element whose name is Capitalized
//   is a component reference (React convention); a lowercase name is a host
//   element (<div>, <span>) and is filtered by the `#match?` predicate — which
//   the engine's captures() honors. Member components (<Foo.Bar>) are deferred.
//
// These JSX patterns reference node types that exist only in the tsx grammar,
// which is why tsx needs its own query rather than sharing typescript's (the
// non-JSX typescript grammar would reject them at Query compile time).
export const refsQuery = `${typescriptRefsQuery}
(jsx_opening_element name: (identifier) @ref.instantiate (#match? @ref.instantiate "^[A-Z]"))
(jsx_self_closing_element name: (identifier) @ref.instantiate (#match? @ref.instantiate "^[A-Z]"))
`;
