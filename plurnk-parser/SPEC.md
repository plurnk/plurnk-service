# @plurnk/plurnk-parser — SPEC

## §parser-build Package boundary, build, and MCP tool-call / statement parser

`@plurnk/plurnk-parser` implements the lowering and serialization rules specified by `@plurnk/plurnk-contracts`. It owns `McpExpressions`, `CallExpressionParser`, `OptionCoercion`, `StatementLowering`, `ExpressionSerializer`, `TargetSyntax`, `ScopeSyntax`, `MatcherSyntax`, the `PlurnkParser` entry points (`lowerMcpCall`, `lowerToolCall`, `parseStatements`, `toMcpCall`, `stringify`), `parsePath`, `targetMembers`, and the `plurnk-parser` CLI.

- **Consumer boundary**: Only the service's execution path (`plurnk-core`, `plurnk-acp`, `plurnk-mcp`, `plurnk-execs`) imports `@plurnk/plurnk-parser`. `@plurnk/plurnk-contracts` declares no dependency on `@plurnk/plurnk-parser`, `xpath`, or `json-p3`.
- **Lowering and serialization**: `McpExpressions`, `CallExpressionParser`, `OptionCoercion`, and `StatementLowering` lower wire `mcp` tool calls (`PlurnkParser.lowerMcpCall`), inbound `/mcp` tool calls (`PlurnkParser.lowerToolCall`), and client/internal statement blocks (`PlurnkParser.parseStatements`) through one shared `dispatchCall` pipeline into typed `PlurnkStatement` AST nodes; `ExpressionSerializer` projects AST nodes to `McpToolCallPayload` (`PlurnkParser.toMcpCall`) for structured `assistant` `toolCalls` replay and renders JSON-escaped `<server>.<tool>({}) // aside` statements (`PlurnkParser.stringify`) for `ops://` source reflection.
- **Build and installation gate**: `npm run build` compiles the package cleanly into `dist/`. `npm run test:installation` packs both `@plurnk/plurnk-contracts` and `@plurnk/plurnk-parser` tarballs, installs them into a clean consumer, and verifies all entry points, `parsePath`, the CLI, and browser-bundle compatibility.
