// References query for tree-sitter-c (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import: NOT emitted. `#include` takes a path string (<stdio.h> /
//     "local.h"), not a name-join-resolvable symbol name — SPEC §16 bans
//     path strings from the refs channel. No import refs for C.
//   - call refs capture the callee identifier of a plain call. Calls
//     through function-pointer fields/derefs are not emitted (the field
//     name is data, not a def the name-join can hit).
//   - type refs cover type positions: params, declarations (locals,
//     file-scope, prototypes' return types), struct/union fields,
//     function-definition return types, typedef underlying types, and
//     type_descriptor (casts, sizeof). Tagged uses (`struct Foo x;`,
//     `enum Color c`) are struct/union/enum_specifier WITHOUT a body —
//     `!body` keeps definition names (which carry a body) out of the
//     stream; typedef NAMES live in the declarator field, never captured.
//   - instantiate/inherit: not applicable — C has no constructors or
//     inheritance.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(call_expression function: (identifier) @ref.call)

(struct_specifier !body name: (type_identifier) @ref.type)
(union_specifier !body name: (type_identifier) @ref.type)
(enum_specifier !body name: (type_identifier) @ref.type)

(parameter_declaration type: (type_identifier) @ref.type)
(declaration type: (type_identifier) @ref.type)
(field_declaration type: (type_identifier) @ref.type)
(function_definition type: (type_identifier) @ref.type)
(type_definition type: (type_identifier) @ref.type)
(type_descriptor type: (type_identifier) @ref.type)
`;
