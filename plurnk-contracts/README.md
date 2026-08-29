# @plurnk/plurnk-contracts

The single authority for PLURNK's model-facing language, parser and AST,
generated model rail, shared schemas and types, runtime-neutral Problems,
operation results, Notices, and text coordinates. See SPEC
{§contract-authority}.

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
| Accepted language syntax        | `plurnkLexer.g4` and `plurnkParser.g4`               |
| Shared wire shapes              | `schema/*.json`                                      |
| JavaScript and TypeScript API   | `@plurnk/plurnk-contracts`                           |
| Published JSON Schemas          | `@plurnk/plurnk-contracts/schema/*.json`             |
| Optional local-model rails      | `@plurnk/plurnk-contracts/plurnk.{gemma,qwen}.gbnf`  |

JSON Schema owns shared wire shapes, generated TypeScript projects those
shapes, ANTLR owns accepted model-language syntax, and GBNF is a bounded
generation aid. See SPEC {§contract-representations} and
{§gbnf-rail-purpose}.

## Parser

```ts
import { PlurnkParser } from "@plurnk/plurnk-contracts";

const result = PlurnkParser.parse(input);

for (const item of result.items) {
    if (item.kind === "statement") {
        console.log(item.statement.op);
    }
}
```

Parse items are ordered and discriminate as `statement`, `error`, or `text`.
The parser entry points deliberately accept different document tiers:

| Entry point                    | Accepted input                                        |
|--------------------------------|-------------------------------------------------------|
| `PlurnkParser.parse`           | One operation-bearing model turn; omitted PLAN/SEND are recovered |
| `PlurnkParser.parseStatements` | A strict sequence of protocol statements              |
| `PlurnkParser.parseLog`        | Strict consecutive PLAN-through-SEND turns            |
| `PlurnkParser.parseClient`     | Protocol statements plus client-only LOOK and BUFF    |
| `parsePath`                    | One path or URI using parser-equivalent decomposition |

See SPEC {§turn-shape} and {§tier-entrypoints} for the tier boundaries. All
AST, parse-result, schema-derived, and runtime-neutral wire types are exported
from the package root.

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

## CLI

```text
plurnk-contracts [file]    parse a file, or standard input when omitted
plurnk-contracts --help    show usage
```

The CLI prints the parse result as JSON and exits `0` for a clean parse or `1`
when the result contains an error or unparsed tail.

## Optional GBNF artifact

```ts
const railUrl = import.meta.resolve(
    "@plurnk/plurnk-contracts/plurnk.qwen.gbnf",
);
```

Choose `gemma` when the model generates its complete
`<|channel>thought … <channel|>` enclosure, or `qwen` when the chat template
supplies `<think>\n` before sampled token zero. The latter artifact is named
`qwen` because that prefill is Qwen's template protocol, not a general property
of think tags. Both constrain the same PLURNK
turn after reasoning. They are not second parsers and do not guarantee
semantically valid output. See SPEC {§gbnf-turn-shape} and
{§gbnf-reasoning-boundary}.

## Development

```sh
npm run build
npm test
npm run test:installation
```

Generated parser, schema-type, distribution, and GBNF artifacts are rebuilt by
`npm run build`. Change their grammar, schema, or generator owner rather than
editing generated output directly.

## License

MIT
