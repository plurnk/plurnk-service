// References query for tree-sitter-julia (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import refs capture the BOUND symbol names: plain module names
//     (`using LinearAlgebra`), the trailing segment of dotted paths
//     (`using Foo.Bar` → Bar), relative paths (`import ..Rel` → Rel), and
//     selected bindings (`using Printf: format` → Printf AND format; macro
//     bindings `@printf` → printf, matching the defs channel which strips
//     `@`). `as` rebinds (`import Statistics as Stats`,
//     `using M: pretty as pp`) capture the ORIGINAL name, never the alias
//     (first-child anchor on import_alias).
//   - call refs capture the callee name node: plain (`f(x)`), qualified
//     (`Stats.mean(x)` → mean, the field_expression's trailing identifier),
//     broadcast (`area.(xs)` → area), and macro invocations (`@twice ...` →
//     twice, `@` stripped to join with macro defs). Julia constructors are
//     syntactically calls (`Circle(1.0)`), so they classify as `call` — the
//     Python precedent; no `instantiate` patterns.
//   - DEF-SHAPE EXCLUSION: Julia definitions are themselves call-shaped —
//     `function f(x)` wraps a call_expression in `signature`, and short-form
//     `f(x) = expr` is an `assignment` whose FIRST child is a
//     call_expression. tree-sitter-julia exposes no fields, so the def heads
//     cannot be excluded by negation; instead call patterns enumerate the
//     POSITIVE use contexts (statement blocks and expression positions), and
//     assignment RHS is anchored after the `=` operator. typed_expression is
//     deliberately NOT a call context: `f(x)::T` asserts share its shape with
//     `function f(x)::T` signatures (precision over recall).
//   - inherit refs capture the supertype after `<:` in type_head
//     (struct/mutable struct/abstract/primitive definitions): plain
//     identifiers, qualified (`Base.AbstractFoo` → AbstractFoo), and
//     parametric (`AbstractArray{T}` → AbstractArray) supertypes. The
//     defined name (before `<:`) is never captured — the pattern requires a
//     preceding operator and end-anchors the capture.
//   - type refs capture `::T` annotations wherever typed_expression wraps
//     them (params, struct fields, locals, return types, asserts): the
//     trailing identifier, parametric heads (`Vector{Point}` → Vector) and
//     their identifier parameters (→ Point, the Python `List[int]`
//     precedent). Qualified types and `where` constraints are skipped.
//   - `use` is reserved; bare identifier reads are not emitted (SPEC §16
//     invariants).

// Parents in which a call_expression is a USE, never a definition head.
const CALL_CONTEXTS = [
    "source_file",
    "module_definition",
    "function_definition",
    "macro_definition",
    "if_statement",
    "elseif_clause",
    "else_clause",
    "for_statement",
    "while_statement",
    "try_statement",
    "catch_clause",
    "finally_clause",
    "let_statement",
    "do_clause",
    "compound_statement",
    "return_statement",
    "argument_list",
    "macro_argument_list",
    "named_argument",
    "binary_expression",
    "unary_expression",
    "parenthesized_expression",
    "tuple_expression",
    "vector_expression",
    "index_expression",
    "range_expression",
    "ternary_expression",
    "comprehension_expression",
];

const CALLEE = "[(identifier) @ref.call (field_expression (identifier) @ref.call .)]";

export const refsQuery = `
(using_statement (identifier) @ref.import)
(import_statement (identifier) @ref.import)
(using_statement (scoped_identifier (identifier) @ref.import .))
(import_statement (scoped_identifier (identifier) @ref.import .))
(using_statement (import_path (identifier) @ref.import .))
(import_statement (import_path (identifier) @ref.import .))
(selected_import (identifier) @ref.import)
(selected_import (scoped_identifier (identifier) @ref.import .))
(selected_import (macro_identifier (identifier) @ref.import))
(import_alias . (identifier) @ref.import)
(import_alias . (scoped_identifier (identifier) @ref.import .))
(import_alias . (macro_identifier (identifier) @ref.import))

(type_head (binary_expression (operator) (identifier) @ref.inherit .))
(type_head (binary_expression (operator) (field_expression (identifier) @ref.inherit .) .))
(type_head (binary_expression (operator) (parametrized_type_expression . (identifier) @ref.inherit) .))

(typed_expression (identifier) @ref.type .)
(typed_expression (parametrized_type_expression . (identifier) @ref.type) .)
(typed_expression (parametrized_type_expression (curly_expression (identifier) @ref.type) .))

(broadcast_call_expression . (identifier) @ref.call)
(broadcast_call_expression . (field_expression (identifier) @ref.call .))
(macrocall_expression (macro_identifier (identifier) @ref.call))

(assignment (operator) (call_expression . ${CALLEE}))
${CALL_CONTEXTS.map((ctx) => `(${ctx} (call_expression . ${CALLEE}))`).join("\n")}
`;
