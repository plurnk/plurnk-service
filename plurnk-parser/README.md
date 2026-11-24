# @plurnk/plurnk-parser

The MCP tool-call lowerer, statement parser, canonical serializer, and path decomposer for PLURNK. It lowers wire `mcp` tool calls (`PlurnkParser.lowerMcpCall`), inbound `/mcp` tool calls (`PlurnkParser.lowerToolCall`), and protocol statement blocks (`PlurnkParser.parseStatements`) into the `PlurnkStatement` AST that [`@plurnk/plurnk-contracts`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts) specifies, and projects statements back to `McpToolCallPayload` (`PlurnkParser.toMcpCall`) and canonical statement text (`PlurnkParser.stringify`).

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

const result = PlurnkParser.lowerMcpCall({
    name: "mcp",
    arguments: { server: "plurnk", tool: "read", arguments: { path: "README.md" } },
});

for (const item of result.items) {
    if (item.kind === "statement") {
        console.log(item.statement.op);
    }
}
```

Parse items are ordered and discriminate as `statement` or `error`.

| Entry point | Accepted input |
|---|---|
| `PlurnkParser.lowerMcpCall` | One wire `mcp` tool call (`{ name: "mcp", arguments: { server, tool, aside, arguments } }`; omitted `aside` tolerated on model tier) |
| `PlurnkParser.lowerToolCall` | One inbound `/mcp` tool call (`(service, tool, args?, options?)`) |
| `PlurnkParser.parseStatements` | A sequence of protocol/internal `<server>.<tool>({...})` statements |
| `PlurnkParser.toMcpCall` | Structured `{ server, tool, aside, arguments }` projection for a statement (`aside: ""` when absent) |
| `PlurnkParser.stringify` | Canonical `<server>.<tool>({}) // aside` serialization for an AST list |
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
