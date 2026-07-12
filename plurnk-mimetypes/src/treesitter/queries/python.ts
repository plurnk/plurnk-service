// References query for tree-sitter-python (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import refs capture the BOUND symbol names (resolvable to defs by the
//     service's name-join), never module-path strings. Aliased imports
//     (`import numpy as np`, `from m import x as y`) capture the ORIGINAL
//     name, not the alias. For dotted names (`import os.path`,
//     `from pkg import a.b`) the trailing identifier is captured (the `.`
//     end-anchor).
//   - call refs capture the callee name node (attribute name for method
//     calls), not the expression root. Python class instantiation is
//     syntactically indistinguishable from a call (`Helper()`), so ALL
//     calls are classified `call` — no `instantiate` patterns.
//   - inherit refs capture class_definition superclasses: plain identifiers
//     and the attribute name of module-qualified bases (`mixins.Runnable`
//     → `Runnable`). `metaclass=...` keyword arguments do not match.
//   - type refs capture identifier type names wherever the grammar wraps
//     them in a `type` node (typed parameters, return types, variable
//     annotations, generic parameters — `List[int]` yields both `List` and
//     `int`). Qualified (`t.Optional`) and union types are skipped:
//     precision over recall.
//   - `use` is reserved; bare identifier reads are not emitted (SPEC §16
//     invariants).
export const refsQuery = `
(import_statement name: (dotted_name (identifier) @ref.import .))
(import_statement name: (aliased_import name: (dotted_name (identifier) @ref.import .)))
(import_from_statement name: (dotted_name (identifier) @ref.import .))
(import_from_statement name: (aliased_import name: (dotted_name (identifier) @ref.import .)))

(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))

(class_definition superclasses: (argument_list (identifier) @ref.inherit))
(class_definition superclasses: (argument_list (attribute attribute: (identifier) @ref.inherit)))

(type (identifier) @ref.type)
(type (generic_type (identifier) @ref.type))
`;
