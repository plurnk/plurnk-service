# plurnk-mimetypes

`@plurnk/plurnk-mimetypes` defines content handlers used by schemes and core.

The package owns handler discovery and the interfaces for parsing, rendering,
matching, symbols, tokenization, and embeddings. Format-specific packages own
their respective behavior and optional dependencies.

The runtime must remain portable; syntax-tree handlers consume WebAssembly
grammar packages through `web-tree-sitter`. Native upstream grammar packages
are build inputs for external grammar packages, not runtime dependencies here.
`SPEC.md` defines the handler contract.
