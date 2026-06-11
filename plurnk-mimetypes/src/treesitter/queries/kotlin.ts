// References query for tree-sitter-kotlin (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions (mirrors queries/typescript.ts and queries/python.ts):
//   - import refs capture the FINAL identifier of the dotted path
//     (`import com.x.Helper` → Helper). Aliased imports (`import x.Y as Z`)
//     capture the ORIGINAL name Y. Wildcard imports are skipped: the `*` is
//     an anonymous token in this grammar (unlike java's named `asterisk`),
//     so the end anchor can't exclude it — the #not-match? predicate on the
//     import node does.
//   - call refs capture the callee name node (the final identifier of a
//     navigation_expression for member calls), not the expression root.
//     Kotlin constructor invocation is syntactically indistinguishable from
//     a call (`Helper()` is call_expression), so ALL calls are classified
//     `call` — no `instantiate` patterns (python precedent).
//   - inherit refs capture supertype names in delegation specifiers: plain
//     types, constructor invocations (`Base()`), and `by` delegation
//     (`Closeable by impl` → Closeable). Qualified supertypes capture the
//     final identifier (the `.` end-anchor — user_type is dotted).
//   - type refs capture user_type names in annotation positions (primary
//     constructor params, function params, return types, property types,
//     nullable types, generic arguments, type-alias targets). The TYPE name
//     of a dotted user_type is its last identifier — unless type_arguments
//     follow, hence the paired `. (type_arguments)` patterns (`List<Token>`
//     yields both List and Token). Class/object/interface definition names
//     are plain identifiers, never user_type, so defs are never captured.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
((import (qualified_identifier (identifier) @ref.import .) .) @_import (#not-match? @_import "\\\\*"))
(import (qualified_identifier (identifier) @ref.import .) (identifier))

(call_expression . (identifier) @ref.call)
(call_expression (navigation_expression (identifier) @ref.call .))

(delegation_specifier (constructor_invocation (user_type (identifier) @ref.inherit .)))
(delegation_specifier (user_type (identifier) @ref.inherit .))
(explicit_delegation (user_type (identifier) @ref.inherit .))

(class_parameter (user_type (identifier) @ref.type .))
(class_parameter (user_type (identifier) @ref.type . (type_arguments)))
(parameter (user_type (identifier) @ref.type .))
(parameter (user_type (identifier) @ref.type . (type_arguments)))
(variable_declaration (user_type (identifier) @ref.type .))
(variable_declaration (user_type (identifier) @ref.type . (type_arguments)))
(function_declaration (user_type (identifier) @ref.type .))
(function_declaration (user_type (identifier) @ref.type . (type_arguments)))
(nullable_type (user_type (identifier) @ref.type .))
(type_projection (user_type (identifier) @ref.type .))
(type_projection (user_type (identifier) @ref.type . (type_arguments)))
(type_alias (user_type (identifier) @ref.type .))
(type_alias (user_type (identifier) @ref.type . (type_arguments)))
`;
