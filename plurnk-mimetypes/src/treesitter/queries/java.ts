// References query for tree-sitter-java (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions (mirrors queries/typescript.ts):
//   - import refs capture the FINAL identifier of the dotted path
//     (`import java.util.List` → List). The trailing `.` anchor makes the
//     scoped_identifier the LAST named child, which excludes wildcard
//     imports — their `asterisk` node follows it.
//   - call refs capture the method_invocation name node (never the receiver).
//   - type refs are limited to declaration positions (field / param / local /
//     return) plus type-argument and array-element slots; `var` is a
//     type_identifier in the grammar, hence the #not-eq? filter. Class /
//     interface / enum declaration names are plain `identifier` nodes in
//     this grammar, so type_identifier never collides with a def name node.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(import_declaration (scoped_identifier name: (identifier) @ref.import) .)

(method_invocation name: (identifier) @ref.call)

(object_creation_expression type: (type_identifier) @ref.instantiate)
(object_creation_expression type: (generic_type (type_identifier) @ref.instantiate))

(superclass (type_identifier) @ref.inherit)
(super_interfaces (type_list (type_identifier) @ref.inherit))
(extends_interfaces (type_list (type_identifier) @ref.inherit))

(field_declaration type: (type_identifier) @ref.type)
(field_declaration type: (generic_type (type_identifier) @ref.type))
(formal_parameter type: (type_identifier) @ref.type)
(formal_parameter type: (generic_type (type_identifier) @ref.type))
((local_variable_declaration type: (type_identifier) @ref.type) (#not-eq? @ref.type "var"))
(local_variable_declaration type: (generic_type (type_identifier) @ref.type))
(method_declaration type: (type_identifier) @ref.type)
(method_declaration type: (generic_type (type_identifier) @ref.type))
(array_type element: (type_identifier) @ref.type)
(type_arguments (type_identifier) @ref.type)
`;
