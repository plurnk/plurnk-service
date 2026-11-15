# @plurnk/plurnk-parser

The MCP expression parser and Reflective Emission Normalization (RENO) engine for PLURNK: declarative `<mcp>.<tool>({}) // aside` expression admission (with `<<<EOF` raw literals and tolerated leading `await`), deterministic post-training envelope transduction, canonical reflective serialization (`PlurnkParser.stringify`), and path decomposition. It implements the MCP expression language that [`@plurnk/plurnk-contracts`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts) specifies and teaches; the AST and wire types it produces belong to `@plurnk/plurnk-contracts`.

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

Parse items are ordered and discriminate as `statement`, `error`, or `text`.
In `parse()`, outside prose is preserved as `{ kind: "text", content, position }`; in `parseStatements()`, outside prose is ignored.
The parser entry points deliberately accept different document tiers:

| Entry point | Accepted input |
|---|---|
| `PlurnkParser.parse` | One model turn batch of MCP expressions (`plurnk.<tool>(...)` / `<mcp>.<tool>(...)`) |
| `PlurnkParser.parseStatements` | A sequence of protocol MCP expressions |
| `PlurnkParser.stringify` | Canonical `<mcp>.<tool>({}) // aside` serialization for an AST list |
| `parsePath` | One path or URI using parser-equivalent decomposition |

See the contracts SPEC ({§whitespace-contract}) for the tier boundaries. The AST, parse-result, and wire types come from `@plurnk/plurnk-contracts`.

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

## License

MIT
