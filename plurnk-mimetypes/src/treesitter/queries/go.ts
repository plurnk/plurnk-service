// References query for tree-sitter-go (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import: NOT emitted. Go imports are package PATHS (string literals),
//     not name-join-resolvable symbol names — `import "fmt"` binds a path,
//     and an alias (`alias "strings"`) binds a local package name, neither
//     of which resolves to a def by the service's name-join. v1 decision:
//     no import refs for Go; the service's import-aware disambiguation has
//     no Go signals yet.
//   - call refs capture the callee name node (selector field name for
//     method/package calls), not the expression root.
//   - instantiate: composite literals (`T{...}`) — Go's instantiation idiom.
//   - type refs cover declaration type positions: params (incl. pointer
//     receivers), var specs, named struct fields, single result types, and
//     the name side of qualified types (`pkg.T`). type_spec underlying
//     types (`type T int`) are skipped — the def channel already records
//     the spec.
//   - inherit: struct embedding — a field_declaration with a type but no
//     name field.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(call_expression function: (identifier) @ref.call)
(call_expression function: (selector_expression field: (field_identifier) @ref.call))

(composite_literal type: (type_identifier) @ref.instantiate)

(parameter_declaration type: (type_identifier) @ref.type)
(parameter_declaration type: (pointer_type (type_identifier) @ref.type))
(var_spec type: (type_identifier) @ref.type)
(field_declaration name: (field_identifier) type: (type_identifier) @ref.type)
(function_declaration result: (type_identifier) @ref.type)
(method_declaration result: (type_identifier) @ref.type)
(qualified_type name: (type_identifier) @ref.type)

(field_declaration !name type: (type_identifier) @ref.inherit)
`;
