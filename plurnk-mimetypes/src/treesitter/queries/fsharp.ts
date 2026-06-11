// References query for tree-sitter-fsharp (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts). Also serves text/x-fsharp-signature —
// the signature grammar shares these node names.
//
// Conventions:
//   - import refs capture the `open` target's full dotted long_identifier
//     (`open Geometry.Core` → "Geometry.Core"): the mapping emits
//     named_module/namespace defs under their full dotted name, so the
//     dotted text IS the joinable form. Final-segment capture would not
//     join.
//   - call refs capture the application head's name — F# application is
//     juxtaposition, so the head is the FIRST child of
//     application_expression (the `.` anchor); arguments are the same
//     long_identifier_or_op shape and must not match. Dotted heads
//     (`h.Run input`) capture the final identifier (the `.` end-anchor).
//   - instantiate is not emitted: `Helper()` is syntactically a plain
//     application, and `new Base()` merely wraps the same application in a
//     prefixed_expression — capturing it separately would double-emit the
//     head. All construction is classified `call` (python precedent,
//     SPEC §16).
//   - inherit refs capture `inherit Base(...)` clauses and
//     `interface I with` implementations inside type definitions.
//   - type refs capture annotation type names in their use contexts only
//     (typed patterns, record fields, function return types, member
//     signatures) — never via a bare simple_type pattern, which would also
//     match the inherit/interface clauses and type DEFINITION heads.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(import_decl (long_identifier) @ref.import)

(application_expression . (long_identifier_or_op (identifier) @ref.call))
(application_expression . (long_identifier_or_op (long_identifier (identifier) @ref.call .)))

(class_inherits_decl (simple_type (long_identifier) @ref.inherit))
(interface_implementation (simple_type (long_identifier) @ref.inherit))

(typed_pattern (simple_type (long_identifier) @ref.type))
(record_field (simple_type (long_identifier) @ref.type))
(function_or_value_defn (simple_type (long_identifier) @ref.type))
(argument_spec (simple_type (long_identifier) @ref.type))
(curried_spec (simple_type (long_identifier) @ref.type))
`;
