// References query for @tree-sitter-grammars/tree-sitter-lua (issue #19;
// SPEC §16). S-expression patterns; `@ref.<kind>` captures yield MimeRef
// rows via the framework engine (refsEngine.ts).
//
// Conventions:
//   - call refs capture the function_call's name node: bare identifier
//     calls (`helper(x)`), dotted calls (`M.fn(x)` → fn via the
//     dot_index_expression field), and method calls (`obj:method(x)` →
//     method via the method_index_expression method field). Chained tables
//     (`a.b.c(x)`) capture the final field — the callee name. `require` is
//     excluded: it is the import mechanism, not a code call (Ruby
//     precedent).
//   - import: `require("path")` takes a path STRING, never a bindable
//     symbol name — no import refs are emitted (same rationale as Go).
//     `local x = require(...)` binds x, but that binding is the defs
//     channel's concern, not a reference.
//   - inherit: Lua inheritance is dynamic metatable wiring (`setmetatable`,
//     `__index` assignment) — too dynamic to attribute statically; no
//     inherit refs (precision over recall).
//   - type/instantiate: not applicable — Lua has no type annotations and
//     no constructor syntax; tables are built with `{}` literals.
//   - `use` is reserved; bare identifier reads are not emitted (SPEC §16
//     invariants).
export const refsQuery = `
((function_call name: (identifier) @ref.call)
  (#not-eq? @ref.call "require"))
(function_call name: (dot_index_expression field: (identifier) @ref.call))
(function_call name: (method_index_expression method: (identifier) @ref.call))
`;
