// References query for tree-sitter-php (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions (mirrors queries/typescript.ts):
//   - import refs capture the BOUND name: the final segment of a use
//     clause's qualified_name (prefix segments live inside namespace_name,
//     so the clause/qualified_name's direct `name` child IS the final
//     segment). Unprefixed `use Foo` needs the leading anchor so the alias
//     in `use Foo as Bar` (also a direct `name` child, field `alias`) is
//     not captured — aliased imports capture the original name.
//   - call refs capture the callee name node: function_call_expression
//     callees are `name` or `qualified_name` (never bare identifier);
//     member/scoped calls capture the method name, not the receiver/scope.
//   - type refs ride on named_type, which covers parameter, return, and
//     property type positions in one shape; primitive_type is a distinct
//     node (naturally excluded) and nullable `?Foo` wraps named_type in
//     optional_type without duplicating it, so each type surfaces once.
//   - qualified positions (extends \\App\\Base, new Qual\\Name, App\\fn())
//     capture the final segment, same rule as imports.
//   - `use` is reserved; bare variable reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(namespace_use_clause . (name) @ref.import)
(namespace_use_clause (qualified_name (name) @ref.import))

(function_call_expression function: (name) @ref.call)
(function_call_expression function: (qualified_name (name) @ref.call))
(member_call_expression name: (name) @ref.call)
(scoped_call_expression name: (name) @ref.call)

(object_creation_expression (name) @ref.instantiate)
(object_creation_expression (qualified_name (name) @ref.instantiate))

(base_clause (name) @ref.inherit)
(base_clause (qualified_name (name) @ref.inherit))
(class_interface_clause (name) @ref.inherit)
(class_interface_clause (qualified_name (name) @ref.inherit))

(named_type (name) @ref.type)
(named_type (qualified_name (name) @ref.type))
`;
