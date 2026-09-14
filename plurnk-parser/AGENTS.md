# plurnk-parser

`@plurnk/plurnk-parser` is the implementation of the PLURNK language that
`@plurnk/plurnk-contracts` specifies: the ANTLR grammars, the generated lexer
and parser, `AstBuilder`, `PlurnkParser`, `parsePath`, and the CLI.

- The language contract, the schemas, the AST and wire types, and `plurnk.md`
  belong to `plurnk-contracts`; cite its tagged sections, never restate them.
- Generated parser files are artifacts: change the owning grammar and prove
  regeneration through `npm run build:grammar`.
- Only the service's execution path imports this package. A client or a
  presentation surface that needs the wire imports contracts alone
  ({§parser-consumers}); do not add a parser dependency to satisfy display.
- Parser changes require the grammar and tier tests here, the packed-package
  smoke test, and a compatibility review of the core, agui, and execs consumers.
