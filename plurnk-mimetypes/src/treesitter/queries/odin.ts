// References query for tree-sitter-odin (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import: NOT emitted. Odin imports are collection PATHS
//     (`import "core:fmt"` — a string literal), and an alias
//     (`str "core:strings"`) binds a local package name; neither resolves
//     to a def by the service's name-join (go precedent; SPEC §16 bans
//     path strings from the refs channel).
//   - call refs capture the callee identifier. Member calls
//     (`fmt.println(...)`) parse as a member_expression wrapping an INNER
//     call_expression whose function field is the final identifier, so the
//     single pattern captures bare callees and selector finals alike.
//   - instantiate: compound literals (`Foo{...}`) parse as a (struct) node
//     whose first named child is the type identifier — anchored so field
//     identifiers in the body are never captured. Array-of-T literals
//     (`[]T{...}`) wrap the element type in a (type) node instead and
//     surface as type refs.
//   - type refs: every type USE is wrapped in a (type) node (params,
//     return types, struct/union fields, var declarations); the one
//     pattern recurses through pointer/array/tuple wrappers, which nest
//     (type) nodes. Definition NAMES live outside (type) nodes (Odin defs
//     are `Foo :: struct {...}` — the name is a direct declaration child),
//     so no defs leak. Builtins (int, bool, f32) are plain identifiers —
//     the grammar has no primitive_type — they surface but never join.
//   - inherit: not applicable — Odin has no inheritance.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(call_expression function: (identifier) @ref.call)

(struct . (identifier) @ref.instantiate)

(type (identifier) @ref.type)
`;
