// References query for tree-sitter-bash (issue #19; SPEC §16). A shell script's
// edges are its command invocations: a function call and an external command
// are syntactically identical, so every command name is a `call` ref. Local
// function calls (`greet`, `main`) name-join to their function_definition defs;
// external commands (`echo`, `printf`, `git`) never join — dead rows, not wrong
// answers (the make/dockerfile prerequisite pattern; documented decision for
// bash). Command names only appear at command positions, so string/comment
// content never surfaces. The enclosing function (its def spans the body)
// becomes the ref's container; top-level commands have none.
export const refsQuery = `
(command name: (command_name) @ref.call)
`;
