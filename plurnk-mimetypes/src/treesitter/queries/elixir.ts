// References query for tree-sitter-elixir (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Elixir's uniform syntax makes EVERYTHING a `call` node — including def
// headers (`def parse(text)` is a call whose inner `parse(text)` is itself a
// call). Upstream tags.scm relies on tree-sitter-tags' def-over-ref
// suppression to drop those header calls; our engine has no such pass, so
// local call patterns are anchored to positions where def headers cannot
// appear (statement slots, call arguments under a non-def target, binary
// operator operands, keyword-pair values) instead of matching globally.
//
// Conventions:
//   - import: `alias`/`import`/`require` invocations capture the argument
//     alias VERBATIM — elixir module names are dotted and the mapping emits
//     dotted module defs, so name-join works on the full dotted name.
//     `as:` rebinds capture the ORIGINAL (the as-alias lives in a keywords
//     pair, never as a direct arguments child). Braced multi-alias
//     (`alias Foo.{Bar, Baz}`) parses as a `dot` node, not an alias — skipped
//     (precision over recall).
//   - inherit: `use Mod` injects code via __using__ — elixir's closest
//     inheritance analog — so the use'd alias is classified inherit, not
//     import. `@behaviour Mod` (interface contract) is inherit too.
//   - call: local calls capture the target identifier; remote calls
//     (`Mod.fun(...)`) capture the dot's right identifier. The def/kernel
//     special-form keyword family is excluded (mirrors tags.scm's ignore
//     list). A bare identifier with no parens is indistinguishable from a
//     variable read and is not emitted — except as the right operand of `|>`,
//     where it is unambiguously a call.
//   - instantiate: struct literals `%Foo{}` capture the alias verbatim
//     (struct patterns in match position surface too — same node shape).
//   - type: not emitted — typespec types live inside `@spec` attribute
//     expressions where type calls are not cleanly separable from the spec
//     header; skipped (precision over recall).
//   - `use` (the RefKind) is reserved; bare identifier reads are not emitted
//     (SPEC §16 invariants).
const DEF_FAMILY = `"def" "defp" "defdelegate" "defguard" "defguardp"
    "defmacro" "defmacrop" "defn" "defnp" "defmodule" "defprotocol" "defimpl"
    "defstruct" "defexception" "defoverridable"`;
const NOT_CALLS = `${DEF_FAMILY}
    "alias" "import" "require" "use"
    "case" "cond" "for" "if" "quote" "raise" "receive" "reraise"
    "super" "throw" "try" "unless" "unquote" "unquote_splicing" "with"`;

export const refsQuery = `
((call target: (identifier) @_kw (arguments (alias) @ref.import))
  (#any-of? @_kw "alias" "import" "require"))

((call target: (identifier) @_use (arguments (alias) @ref.inherit))
  (#eq? @_use "use"))
((unary_operator operator: "@" operand: (call target: (identifier) @_behaviour (arguments (alias) @ref.inherit)))
  (#eq? @_behaviour "behaviour"))

(call target: (dot right: (identifier) @ref.call))

([(do_block (call target: (identifier) @ref.call))
  (else_block (call target: (identifier) @ref.call))
  (body (call target: (identifier) @ref.call))]
 (#not-any-of? @ref.call ${NOT_CALLS}))

((call target: (identifier) @_outer (arguments (call target: (identifier) @ref.call)))
  (#not-any-of? @_outer ${DEF_FAMILY})
  (#not-any-of? @ref.call ${NOT_CALLS}))
((call target: (dot) (arguments (call target: (identifier) @ref.call)))
  (#not-any-of? @ref.call ${NOT_CALLS}))

((binary_operator right: (call target: (identifier) @ref.call))
  (#not-any-of? @ref.call ${NOT_CALLS}))
((binary_operator operator: "|>" left: (call target: (identifier) @ref.call))
  (#not-any-of? @ref.call ${NOT_CALLS}))
(binary_operator operator: "|>" right: (identifier) @ref.call)

((pair (call target: (identifier) @ref.call))
  (#not-any-of? @ref.call ${NOT_CALLS}))

(struct (alias) @ref.instantiate)
`;
