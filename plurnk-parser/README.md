# @plurnk/plurnk-parser

The parser for the PLURNK model language: the ANTLR grammars, the generated
lexer and parser, the AST builder, and path decomposition. It implements the
language that [`@plurnk/plurnk-contracts`](../plurnk-contracts) specifies and
teaches; the AST and wire types it produces are the contracts package's.

## Install

```sh
npm install @plurnk/plurnk-parser
```

The service's execution path is the consumer. A client that validates or
presents the wire needs only `@plurnk/plurnk-contracts`, which carries no parser
runtime.

## Parser

```ts
import { PlurnkParser } from "@plurnk/plurnk-parser";

const result = PlurnkParser.parse(input);

for (const item of result.items) {
    if (item.kind === "statement") {
        console.log(item.statement.op);
    }
}
```

Parse items are ordered and discriminate as `statement` or `error`.
Outside-block text is ignored in every tier; literal bodies remain exact.
The parser entry points deliberately accept different document tiers:

| Entry point                    | Accepted input                                        |
|--------------------------------|-------------------------------------------------------|
| `PlurnkParser.parse`           | One operation-bearing model turn; omitted lifecycle declaration continues silently |
| `PlurnkParser.parseStatements` | A sequence of protocol statements                     |
| `PlurnkParser.parseLog`        | Consecutive disposition-ended turns                    |
| `PlurnkParser.parseClient`     | Protocol statements plus the client-only LOOK         |
| `parsePath`                    | One path or URI using parser-equivalent decomposition |

See the contracts SPEC {§turn-shape} and {§tier-entrypoints} for the tier
boundaries. The AST, parse-result, and wire types come from
`@plurnk/plurnk-contracts`.

## CLI

```text
plurnk-parser [file]    parse a file, or standard input when omitted
plurnk-parser --help    show usage
```

The CLI prints the parse result as JSON and exits `0` for a clean parse or `1`
when the result contains an error or unparsed tail.

## Development

```sh
npm run build
npm test
npm run test:installation
```

`npm run build:grammar` regenerates the parser from `plurnkLexer.g4` and
`plurnkParser.g4`. Change the grammar rather than editing generated output.

## License

MIT
