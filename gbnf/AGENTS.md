# gbnf

`@plurnk/gbnf` is a Node-native parser and validator for GBNF grammars.

The published package is implemented in TypeScript under `src`. Build it with
`npm run build`; the build is deterministic and does not access the network.

The optional llama.cpp differential oracle is maintenance and test tooling:

```sh
npm run oracle:fetch
npm run oracle:build
npm run test:e2e
```

`oracle:fetch` regenerates vendored test sources from the pinned revision.
`oracle:check` reports whether upstream has advanced. The shared pin lives in
`scripts/llama-pin.sh`.

Parser changes require focused integration tests and, when compatibility with
llama.cpp is relevant, differential tests against the pinned oracle.
