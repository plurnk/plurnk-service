; References query for tree-sitter-julia ({§mimetype-references}).
; S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
; framework engine (refsEngine.ts).
;
; Conventions:
;   - import refs capture the BOUND symbol names: plain module names
;     (`using LinearAlgebra`), the trailing segment of dotted paths
;     (`using Foo.Bar` → Bar), relative paths (`import ..Rel` → Rel), and
;     selected bindings (`using Printf: format` → Printf AND format; macro
;     bindings `@printf` → printf, matching the defs channel which strips
;     `@`). `as` rebinds (`import Statistics as Stats`,
;     `using M: pretty as pp`) capture the ORIGINAL name, never the alias
;     (first-child anchor on import_alias).
;   - call refs capture the callee name node: plain (`f(x)`), qualified
;     (`Stats.mean(x)` → mean, the field_expression's trailing identifier),
;     broadcast (`area.(xs)` → area), and macro invocations (`@twice ...` →
;     twice, `@` stripped to join with macro defs). Julia constructors are
;     syntactically calls (`Circle(1.0)`), so they classify as `call` — the
;     Python precedent; no `instantiate` patterns.
;   - DEF-SHAPE EXCLUSION: Julia definitions are themselves call-shaped —
;     `function f(x)` wraps a call_expression in `signature`, and short-form
;     `f(x) = expr` is an `assignment` whose FIRST child is a
;     call_expression. tree-sitter-julia exposes no fields, so the def heads
;     cannot be excluded by negation; instead call patterns enumerate the
;     POSITIVE use contexts (statement blocks and expression positions), and
;     assignment RHS is anchored after the `=` operator. typed_expression is
;     deliberately NOT a call context: `f(x)::T` asserts share its shape with
;     `function f(x)::T` signatures (precision over recall).
;   - inherit refs capture the supertype after `<:` in type_head
;     (struct/mutable struct/abstract/primitive definitions): plain
;     identifiers, qualified (`Base.AbstractFoo` → AbstractFoo), and
;     parametric (`AbstractArray{T}` → AbstractArray) supertypes. The
;     defined name (before `<:`) is never captured — the pattern requires a
;     preceding operator and end-anchors the capture.
;   - type refs capture `::T` annotations wherever typed_expression wraps
;     them (params, struct fields, locals, return types, asserts): the
;     trailing identifier, parametric heads (`Vector{Point}` → Vector) and
;     their identifier parameters (→ Point, the Python `List[int]`
;     precedent). Qualified types and `where` constraints are skipped.
;   - `use` is reserved; bare identifier reads are not emitted ({§mimetype-references}
;     invariants).
; Parents in which a call_expression is a USE, never a definition head.

(using_statement (identifier) @ref.import)
(import_statement (identifier) @ref.import)
(using_statement (import_path (identifier) @ref.import .))
(import_statement (import_path (identifier) @ref.import .))
(selected_import (identifier) @ref.import)
(selected_import (import_path (identifier) @ref.import .))
(selected_import (macro_identifier (identifier) @ref.import))
(import_alias . (identifier) @ref.import)
(import_alias . (import_path (identifier) @ref.import .))
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

(assignment (operator) (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(index_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(source_file (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(block (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(let_statement (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(do_clause (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(return_statement (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(argument_list (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(macro_argument_list (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(binary_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(unary_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(parenthesized_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(tuple_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(vector_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(range_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(ternary_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
(comprehension_expression (call_expression . [(identifier) @ref.call (field_expression (identifier) @ref.call .)]))
