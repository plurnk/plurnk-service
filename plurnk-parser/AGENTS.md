# plurnk-parser

`@plurnk/plurnk-parser` is the implementation of the PLURNK Code Mode language that
`@plurnk/plurnk-contracts` specifies: `CodeMode`, `PlurnkParser`, `parsePath`, and the CLI.

- The language contract, the schemas, the AST and wire types, and `plurnk.md`
  belong to `plurnk-contracts`; cite its tagged sections, never restate them.
- Only service-side consumers (core, acp, execs) import this package. A client or a
  presentation surface that needs the wire imports contracts alone
  ({§parser-build}); do not add a parser dependency to satisfy display.
- Parser changes require the unit and integration tests here, the packed-package
  smoke test, and a compatibility review of the core, acp, and execs consumers.
