// References query for tree-sitter-ocaml (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import: `open Module` captures the FINAL module_name of the path —
//     `open Outer.Inner` yields "Inner" (the nested name is what the ocaml
//     mapping emits as a def inside `module Outer = struct`, so the final
//     segment is the name-join-resolvable one). `include Module` is OCaml's
//     closest analog to inheritance (the included module's items become part
//     of the includer) → inherit, same final-segment rule.
//   - call: application heads ONLY. The grammar gives application_expression
//     with the callee as the FIRST named child (a value_path), so the `.`
//     anchor captures heads without bare-read noise — argument value_paths
//     and pipeline (`x |> f`) operands never match. Member calls
//     (`Mod.f x`) capture the final value_name ("f").
//   - instantiate: variant-constructor application heads (`Some x`,
//     `Mod.Circle (p, r)`) — constructor_path is capital-initial by grammar.
//     Constructor uses in MATCH PATTERNS are deconstruction, not
//     instantiation, and bare (argument-less) constructor expressions are
//     ambiguous with constant reads — both skipped. Record literals carry no
//     type name in OCaml (`{ x = 0 }`) — nothing to capture; skipped.
//   - type: every type_constructor inside a type_constructor_path — the
//     grammar wraps type USES in type_constructor_path (annotations, val
//     specs, record-field types, variant payloads, alias right-hand sides)
//     while type DEFINITION names are bare type_constructor children of
//     type_binding, so definition names never surface.
//   - `use` is reserved; bare identifier reads are not emitted (precision
//     over recall — SPEC §16 invariants).
export const refsQuery = `
(open_module (module_path (module_name) @ref.import))

(include_module (module_path (module_name) @ref.inherit))

(application_expression . (value_path (value_name) @ref.call))

(application_expression . (constructor_path (constructor_name) @ref.instantiate))

(type_constructor_path (type_constructor) @ref.type)
`;
