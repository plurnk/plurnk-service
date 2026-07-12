// References query for tree-sitter-haskell (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Haskell is whole-program application syntax — almost every expression is
// an `apply` chain — so the conventions here are deliberately conservative
// (precision over recall, SPEC §16):
//   - import: ONLY explicit import-list names (`import Data.List (sort)` →
//     sort). Module names are dotted paths (`Data.List`) and the haskell.ts
//     mapping emits no def they could name-join to (the header module def is
//     a single segment) — so module names, qualified aliases, and bare
//     `import Control.Monad` emit nothing.
//   - call: ONLY the head of an `apply` node whose `function:` field is a
//     plain variable or a qualified variable (`Map.insert` → insert) — the
//     grammar's field structure separates heads from arguments, so argument
//     variables are never captured. Operator application (`f $ x`) and
//     composition pipelines are NOT captured (they parse as infix, not
//     apply).
//   - instantiate: NOT emitted. Constructor application heads (`Token "x"`)
//     parse identically in expressions and in patterns (`render (Circle r)`)
//     — emitting instantiate would misclassify pattern deconstruction, and
//     the grammar gives no cheap way to tell them apart.
//   - inherit: instance declarations' class name (`instance Renderer Shape`
//     → Renderer). The instance's target type (Shape) is a type ref.
//   - type: type-position name nodes, field-scoped so definition name nodes
//     (data/newtype/class/synonym heads) are never captured: signature
//     types (direct, arrow parameter/result, application head + arguments,
//     list/tuple elements) and data/newtype field types (record `type:`,
//     bare newtype field, positional `prefix field:`).
//   - `use` is reserved; bare identifier reads are not emitted.
export const refsQuery = `
(import_name variable: (variable) @ref.import)
(import_name type: (name) @ref.import)

(apply function: (variable) @ref.call)
(apply function: (qualified id: (variable) @ref.call))

(instance name: (name) @ref.inherit)
(instance patterns: (type_patterns (name) @ref.type))

(signature type: (name) @ref.type)
(function parameter: (name) @ref.type)
(function result: (name) @ref.type)
(apply constructor: (name) @ref.type)
(apply argument: (name) @ref.type)
(field (name) @ref.type)
(prefix field: (name) @ref.type)
(list element: (name) @ref.type)
(tuple element: (name) @ref.type)
`;
