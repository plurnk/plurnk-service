// References query for tree-sitter-rust (issue #19; SPEC §16).
// Same conventions as queries/typescript.ts:
//   - import refs capture the BOUND names of use declarations: the trailing
//     path segment (`use std::mem` → mem), each use-list leaf, and the
//     ORIGINAL name in `as` aliases (`Shape as S` → Shape). Wildcard
//     (`use m::*`) binds no nameable symbol and is not emitted.
//   - call refs capture the callee name node: plain identifiers, the method
//     name of field-expression calls, and the final segment of scoped calls
//     (`Helper::create()` → create).
//   - instantiate = struct-literal type names (`Foo { .. }`).
//   - inherit = the trait side of `impl Trait for Type`.
//   - type refs cover field/let/param/return annotations (generic heads
//     included, type arguments not — mirrors the typescript query's scope).
//   - `use` is reserved; bare identifier reads are not emitted.
export const refsQuery = `
(use_declaration argument: (identifier) @ref.import)
(use_declaration argument: (scoped_identifier name: (identifier) @ref.import))
(use_list (identifier) @ref.import)
(use_list (scoped_identifier name: (identifier) @ref.import))
(use_as_clause path: (identifier) @ref.import)
(use_as_clause path: (scoped_identifier name: (identifier) @ref.import))

(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (scoped_identifier name: (identifier) @ref.call))

(struct_expression name: (type_identifier) @ref.instantiate)
(struct_expression name: (scoped_type_identifier name: (type_identifier) @ref.instantiate))

(impl_item trait: (type_identifier) @ref.inherit)
(impl_item trait: (generic_type type: (type_identifier) @ref.inherit))

(field_declaration type: (type_identifier) @ref.type)
(field_declaration type: (generic_type type: (type_identifier) @ref.type))
(let_declaration type: (type_identifier) @ref.type)
(let_declaration type: (generic_type type: (type_identifier) @ref.type))
(parameter type: (type_identifier) @ref.type)
(parameter type: (generic_type type: (type_identifier) @ref.type))
(function_item return_type: (type_identifier) @ref.type)
(function_item return_type: (generic_type type: (type_identifier) @ref.type))
`;
