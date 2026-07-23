# plurnk-grammar

`@plurnk/plurnk-grammar` owns the model-facing language and shared protocol
schemas.

- ANTLR defines accepted syntax and produces diagnostics.
- The generated GBNF grammar constrains supported model backends during
  generation; it is not a second parser contract.
- JSON Schemas are authoritative for shared protocol shapes.
- `plurnk.md` is the concise model-facing language reference.
- Generated parsers and types are build artifacts; change their grammar or
  schema sources instead.

Syntax changes require parser tests, schema/type regeneration when applicable,
and compatibility review across consumers. Diagnostics should identify the
invalid structure and a useful correction without embedding project history or
backend policy.

Use the package scripts for generation, lint, unit tests, and integration tests.
`SPEC.md` documents the public language contract.
