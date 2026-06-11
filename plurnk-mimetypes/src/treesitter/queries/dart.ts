// References query for tree-sitter-dart (issue #19; SPEC §16).
// S-expression patterns; `@ref.<kind>` captures yield MimeRef rows via the
// framework engine (refsEngine.ts).
//
// Conventions:
//   - import refs: dart imports are URI strings (`import 'x.dart'`) — the
//     URI is never emitted (paths are not name-join-resolvable). `show`
//     combinator names ARE bound symbol names and are captured as import;
//     `hide` names are explicitly unbound and excluded — the grammar's
//     combinator node is otherwise identical for both, so the anonymous
//     "show" keyword anchors the pattern.
//   - call refs: dart has no call_expression node — an invocation is an
//     identifier (or `.name` / `?.name` assignable selector) immediately
//     followed by an argument_part selector. The sibling-anchored patterns
//     capture the callee name only when the very next selector is an
//     argument list. Bare `Foo()` instantiation is syntactically identical
//     to a call and classified `call` (python precedent, SPEC §16).
//   - instantiate refs: only explicit `new Foo()` / `const Foo(...)` — the
//     grammar marks those (new_expression / const_object_expression).
//   - inherit refs: extends (superclass), with (mixins), implements
//     (interfaces), and a mixin's `on` constraint (direct type_identifier
//     child of mixin_declaration). Class / mixin / enum DEFINITION names
//     are plain `identifier` nodes in this grammar, so type_identifier
//     never collides with a def name node.
//   - type refs: annotation positions — fields (declaration), params
//     (formal_parameter), returns (function_signature / getter_signature),
//     typed locals (initialized_variable_definition), and type arguments.
//     Casts (`as T`) and tests (`is T`) are skipped: precision over recall.
//   - `use` is reserved; bare identifier reads are not emitted (SPEC §16
//     invariants).
export const refsQuery = `
(combinator "show" (identifier) @ref.import)

((identifier) @ref.call . (selector (argument_part)))
((selector (unconditional_assignable_selector (identifier) @ref.call)) . (selector (argument_part)))
((selector (conditional_assignable_selector (identifier) @ref.call)) . (selector (argument_part)))

(new_expression (type_identifier) @ref.instantiate)
(const_object_expression (type_identifier) @ref.instantiate)

(superclass (type_identifier) @ref.inherit)
(mixins (type_identifier) @ref.inherit)
(interfaces (type_identifier) @ref.inherit)
(mixin_declaration (type_identifier) @ref.inherit)

(declaration (type_identifier) @ref.type)
(initialized_variable_definition (type_identifier) @ref.type)
(formal_parameter (type_identifier) @ref.type)
(function_signature (type_identifier) @ref.type)
(getter_signature (type_identifier) @ref.type)
(type_arguments (type_identifier) @ref.type)
`;
