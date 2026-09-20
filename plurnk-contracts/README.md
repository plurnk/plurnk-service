# @plurnk/plurnk-contracts

The single authority for PLURNK's model-facing language contract, its AST,
generated model rail, shared schemas and types, runtime-neutral Problems,
operation results, Notices, and text coordinates. See SPEC
{§root-value-api}.

## Install

```sh
npm install @plurnk/plurnk-contracts
```

Requires Node.js 26 or newer.

## Contract surfaces

| Surface                         | Authority or public artifact                         |
|---------------------------------|------------------------------------------------------|
| Concise model language teaching | [`plurnk.md`](plurnk.md)                             |
| Stable behavioral contract      | [`SPEC.md`](SPEC.md)                                 |
| Accepted language syntax        | `SPEC.md` ({§canonical-statement}); implemented by `@plurnk/plurnk-parser` |
| Shared wire shapes              | `schema/*.json`                                      |
| JavaScript and TypeScript API   | `@plurnk/plurnk-contracts`                           |
| Published JSON Schemas          | `@plurnk/plurnk-contracts/schema/*.json`             |

JSON Schema owns shared wire shapes, generated TypeScript projects those
shapes, and ANTLR owns accepted model-language syntax. See SPEC
{§contract-representations}. An operator who wants constrained sampling on a
llama-server route writes their own GBNF and points `PLURNK_PROVIDERS_GBNF` at
it; this package ships no grammar profile.

## Parser

The parser that implements this language is [`@plurnk/plurnk-parser`](../plurnk-parser):
`PlurnkParser` and `parsePath` are its exports, and it depends on this package for
the AST and wire types. A consumer that validates or presents the wire needs only
this package.

## Wire validation

```ts
import {
    Problems,
    Validator,
    type OperationResult,
} from "@plurnk/plurnk-contracts";

const problem = Problems.create("scheme:file", "not-found", 404, "Missing.");
const result: OperationResult = { status: 404, problem };

Validator.assertOperationResult(result);
```

Generated wire types, constructors, and validators share the package root entry
point described by SPEC {§wire-entrypoint}. Owning JSON Schemas use the published
`@plurnk/plurnk-contracts/schema/*.json` subpaths.

## Development

```sh
npm run build
npm test
npm run test:installation
```

Generated schema-type and distribution artifacts are rebuilt by `npm run build`.
Change the owning schema rather than editing generated output directly; the
grammar and its generated parser live in `@plurnk/plurnk-parser`.

## License

MIT
