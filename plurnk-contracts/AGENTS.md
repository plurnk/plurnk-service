# plurnk-contracts

`@plurnk/plurnk-contracts` is the single authority for the model-facing
language, generated AST and wire types, JSON Schemas, parser, model rail,
runtime-neutral results/failures/notices, and universal text coordinates.

- ANTLR defines accepted model-language syntax and produces diagnostics.
- The generated GBNF artifact is a lean stochastic generation aid, not a
  second parser or a guarantee of semantically valid model output.
- JSON Schemas are authoritative for shared wire shapes; TypeScript types are
  generated from them.
- The package root exposes runtime-neutral wire contracts without loading the
  parser. The `./grammar` subpath exposes parser and AST behavior.
- `plurnk.md` is the concise model-facing language reference.
- Generated parser, type, and GBNF files are artifacts; change their owning
  grammar, schema, or generator and prove regeneration identity.

One fact has one owner. Do not recreate a grammar/contracts split through a
second package, copied schema, compatibility facade, or consumer-local type.
Public behavior belongs in tagged sections of `SPEC.md`; tests and comments
cite those tags or issue numbers instead of restating the contract.

Contract changes require the relevant parser/schema tests, generated-artifact
checks, packed-package smoke test, and compatibility review across consumers.
