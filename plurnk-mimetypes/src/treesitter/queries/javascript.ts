// References query for tree-sitter-javascript (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions (shared with queries/typescript.ts):
//   - import refs capture the BOUND symbol names (resolvable to defs by the
//     service's name-join), never module-path strings. Aliased imports
//     (`{ Other as O }`) capture the original exported name.
//   - call refs capture the callee name node (property name for member
//     calls), not the expression root.
//   - JavaScript has no type annotations — no `type` patterns.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
//
// Grammar note: tree-sitter-javascript wraps `extends X` in class_heritage
// holding a bare expression — there is no extends_clause (that's the TS
// grammar's node).
export const refsQuery = `
(import_specifier name: (identifier) @ref.import)
(import_clause (identifier) @ref.import)

(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))

(new_expression constructor: (identifier) @ref.instantiate)

(class_heritage (identifier) @ref.inherit)
`;
