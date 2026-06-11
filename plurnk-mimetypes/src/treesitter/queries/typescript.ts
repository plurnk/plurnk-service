// References query for tree-sitter-typescript (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts). Also serves text/x-tsx — the tsx grammar
// is a superset with identical node names for these shapes.
//
// Conventions:
//   - import refs capture the BOUND symbol names (resolvable to defs by the
//     service's name-join), never module-path strings. Aliased imports
//     (`{ Other as O }`) capture the original exported name.
//   - call refs capture the callee name node (property name for member
//     calls), not the expression root.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(import_specifier name: (identifier) @ref.import)
(import_clause (identifier) @ref.import)

(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))

(new_expression constructor: (identifier) @ref.instantiate)

(extends_clause (identifier) @ref.inherit)
(implements_clause (type_identifier) @ref.inherit)

(type_annotation (type_identifier) @ref.type)
(type_annotation (generic_type name: (type_identifier) @ref.type))
`;
