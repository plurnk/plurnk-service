// References query for tree-sitter-make (issue #19 pattern; dev-DSL grind).
// Make is the registry's purest dependency-graph language: a rule's
// prerequisite list IS the edge list make executes. Both capture groups
// classify as `use` — the first legitimate emission of the otherwise-reserved
// kind (SPEC §16): these are declared dependencies, not bare identifier reads.
//
//   - prerequisites: each word is an edge target →use→ prerequisite
//     (`build: compile link` emits compile, link with container "build").
//     File prerequisites (main.c) that aren't also targets simply never
//     name-join — dead rows, not noise.
//   - variable_reference: $(VAR) expansions everywhere — prerequisite lists,
//     recipe shell text, assignment values — join to the variable defs the
//     mapping emits. Recipe shell text is otherwise opaque (shell words are
//     not parsed; `$(MAKE) target` recursion is invisible by design).
//
// Targets' own names live under (targets), never captured. .PHONY is itself
// a rule whose prerequisites reference real targets — semantically correct.
export const refsQuery = `
(prerequisites (word) @ref.use)

(variable_reference (word) @ref.use)
`;
