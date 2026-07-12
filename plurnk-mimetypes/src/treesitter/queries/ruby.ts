// References query for tree-sitter-ruby (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import: `require`/`require_relative` take path STRINGS, never bindable
//     symbol names — no import refs are emitted (same rationale as Go).
//   - call refs capture the call node's method name (`(call method: ...)`).
//     The grammar wraps every call shape — bare commands (`puts "x"`),
//     parenthesized calls, and receiver calls — in a `call` node, so the one
//     pattern covers them all. A BARE identifier with no receiver and no
//     arguments is just `identifier` (indistinguishable from a variable
//     read) and is not emitted — precision over recall. Names classified
//     elsewhere are excluded via #not-any-of?: `new` (→ instantiate),
//     `include`/`extend`/`prepend` (→ inherit), `require`/`require_relative`
//     (import mechanism), `attr_*` (defs-channel sugar — the ruby mapping
//     emits the declared fields).
//   - instantiate refs capture the receiver CONSTANT of a `.new` call
//     (`Helper.new` → Helper; `Foo::Bar.new` → Bar via the scope_resolution
//     name field).
//   - inherit refs capture the class superclass constant (plain or
//     scope-qualified) plus constant arguments to `include`/`extend`/
//     `prepend` — Ruby's mixin inheritance.
//   - type: not applicable — Ruby has no type annotations.
//   - `use` is reserved; bare identifier reads are not emitted (SPEC §16
//     invariants).
export const refsQuery = `
((call method: (identifier) @ref.call)
  (#not-any-of? @ref.call
    "new" "include" "extend" "prepend" "require" "require_relative"
    "attr_accessor" "attr_reader" "attr_writer"))

((call receiver: (constant) @ref.instantiate method: (identifier) @_new)
  (#eq? @_new "new"))
((call receiver: (scope_resolution name: (constant) @ref.instantiate) method: (identifier) @_new)
  (#eq? @_new "new"))

(superclass (constant) @ref.inherit)
(superclass (scope_resolution name: (constant) @ref.inherit))
((call method: (identifier) @_mixin arguments: (argument_list (constant) @ref.inherit))
  (#any-of? @_mixin "include" "extend" "prepend"))
`;
