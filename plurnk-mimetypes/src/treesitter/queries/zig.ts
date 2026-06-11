// References query for tree-sitter-zig (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import: NOT emitted. `@import("std")` takes a path string, not a
//     name-join-resolvable symbol name — SPEC §16 bans path strings from
//     the refs channel. No import refs for Zig.
//   - call refs capture the callee name node (field_expression member for
//     `std.debug.print`-style calls), not the expression root. Builtin
//     calls (`@intCast`, `@import`) parse as distinct builtin_function
//     nodes — never call_expression — so they fall out of the patterns
//     naturally; builtin names are compiler intrinsics, not joinable defs.
//   - instantiate: struct init literals (`Foo{ ... }`) parse as
//     struct_initializer whose only direct identifier child is the type
//     name (initializer contents nest under initializer_list) — captured
//     without a field constraint (the grammar gives the type no field).
//   - type refs cover the grammar's `type:`-fielded positions: params
//     (plain, `*T` pointer_type, `?T` nullable_type), function returns
//     (plain and `!T` error_union_type ok side), struct/enum/union
//     container fields, and explicitly typed variable_declarations.
//     Definition names can't leak in: zig defs are `const Foo = ...` /
//     `fn foo(...)` — the name identifier is unfielded (var decls) or in
//     the `name:` field (fns/params/fields), never in `type:`. Crucially
//     the field constraint also keeps `_ = x;` discard values out — they
//     parse as variable_declaration with a second UNFIELDED identifier.
//   - inherit: not applicable — Zig has no inheritance.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression member: (identifier) @ref.call))

(struct_initializer (identifier) @ref.instantiate)

(parameter type: (identifier) @ref.type)
(parameter type: (pointer_type (identifier) @ref.type))
(parameter type: (nullable_type (identifier) @ref.type))
(function_declaration type: (identifier) @ref.type)
(function_declaration type: (error_union_type ok: (identifier) @ref.type))
(container_field type: (identifier) @ref.type)
(variable_declaration type: (identifier) @ref.type)
`;
