# plurnk-contracts

`@plurnk/plurnk-contracts` is the single authority for the model-facing
language contract, generated AST and wire types, JSON Schemas, model rail,
runtime-neutral results/failures/notices, and universal text coordinates.

- `SPEC.md` defines accepted model-language syntax; `@plurnk/plurnk-parser`
  implements it and produces diagnostics.
- No grammar profile is generated or shipped; an operator's own GBNF rides
  `PLURNK_PROVIDERS_GBNF` to a llama-server route as verbatim text.
- JSON Schemas are authoritative for shared wire shapes; TypeScript types are
  generated from them.
- The package root is the one code API for AST and wire types, schemas, and
  runtime-neutral wire contracts; the parser is `@plurnk/plurnk-parser`'s root.
- `plurnk.md` is the concise model-facing language reference.
- Generated type files are artifacts; change their owning schema and prove
  regeneration identity.

One fact has one owner. The language contract is here and its parser is in
`plurnk-parser` (#653); do not recreate either through a copied schema,
compatibility facade, or consumer-local type.
Public behavior belongs in tagged sections of `SPEC.md`; tests and comments
cite those tags or issue numbers instead of restating the contract.

Contract changes require the relevant schema tests here and the parser's tier
tests, generated-artifact checks, packed-package smoke tests, and compatibility
review across consumers.
