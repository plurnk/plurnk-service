// References query for tree-sitter-scala (issue #19; SPEC §16).
// Same conventions as queries/typescript.ts:
//   - import refs capture the BOUND names: import paths are flat `path:`
//     identifier lists, so the FINAL segment is captured via the `.` anchor
//     (`import a.b.Helper` → Helper); comma-separated groups capture each
//     pre-comma leaf (`import a.B, c.D` → B, D); selector lists capture each
//     leaf and renamed selectors capture the ORIGINAL name
//     (`{Success => Win}` → Success); wildcards (`_`) bind no nameable
//     symbol and are not emitted.
//   - call refs capture the callee name node: plain identifiers and the
//     field name of field-expression calls (`h.run()` → run). Bare apply
//     calls (`Token(input)`) are syntactically calls in this grammar (no
//     `new`), so they classify as call — mirrors the Python convention.
//   - instantiate = `new Foo(...)` instance expressions (generic heads
//     included: `new Buf[T]()` → Buf).
//   - inherit = every type in the extends clause: the extended parent and
//     each `with` mixin are uniform `type:` children of extends_clause.
//   - type refs cover class-parameter/param/val/var/return annotations
//     (generic heads included, type arguments not — mirrors the typescript
//     query's scope). Definition names are `name:` identifiers, never
//     type_identifier, so they cannot be captured here.
//   - `use` is reserved; bare identifier reads are not emitted.
//
// NOTE (probed, not stylistic): import/extends patterns are FIELDLESS.
// In this grammar a repeated field (`type:` on extends_clause) matches only
// its first child when field-constrained, and `path:` plus a trailing `.`
// anchor never matches; the fieldless child patterns behave correctly.
export const refsQuery = `
(import_declaration (identifier) @ref.import .)
(import_declaration (identifier) @ref.import . ",")
(namespace_selectors (identifier) @ref.import)
(arrow_renamed_identifier name: (identifier) @ref.import)

(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (identifier) @ref.call))

(instance_expression (type_identifier) @ref.instantiate)
(instance_expression (generic_type type: (type_identifier) @ref.instantiate))

(extends_clause (type_identifier) @ref.inherit)
(extends_clause (generic_type type: (type_identifier) @ref.inherit))

(class_parameter type: (type_identifier) @ref.type)
(class_parameter type: (generic_type type: (type_identifier) @ref.type))
(parameter type: (type_identifier) @ref.type)
(parameter type: (generic_type type: (type_identifier) @ref.type))
(val_definition type: (type_identifier) @ref.type)
(val_definition type: (generic_type type: (type_identifier) @ref.type))
(var_definition type: (type_identifier) @ref.type)
(var_definition type: (generic_type type: (type_identifier) @ref.type))
(function_definition return_type: (type_identifier) @ref.type)
(function_definition return_type: (generic_type type: (type_identifier) @ref.type))
(function_declaration return_type: (type_identifier) @ref.type)
(function_declaration return_type: (generic_type type: (type_identifier) @ref.type))
`;
