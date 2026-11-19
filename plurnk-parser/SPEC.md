# @plurnk/plurnk-parser — SPEC

## §parser-boundary Public entry points, path decomposition, and CLI

`@plurnk/plurnk-parser` exposes the public parser, serializer, target decomposition helpers, and CLI implementing `@plurnk/plurnk-contracts` ({§mcp-expressions}, {§path-syntax}):

| Entry point | Signature & input | Return & contract |
| --- | --- | --- |
| `PlurnkParser.lowerMcpCall(call, options?)` | Wire `{ name, arguments }` + `LowerToolCallOptions` (`executors`, `aside`, `tier`, `position`) | `ParseResult` (`items` of `{ kind: "statement", statement }` and `{ kind: "error", error, attempt? }`); defaults to `"model"` tier recovery ({§parse-recovery}). |
| `PlurnkParser.lowerToolCall(service, tool, args?, options?)` | Inbound `/mcp` `(service, tool, args?)` + `LowerToolCallOptions` | `ParseResult` lowered through the shared call dispatcher; defaults to `"statements"` tier. |
| `PlurnkParser.parseStatements(input, options?)` | Client or internal `<server>.<tool>(...)` statement source + `ParseOptions` (`executors`) | `ParseResult` over statement blocks and trailing comments/asides ({§expression-boundaries}). |
| `PlurnkParser.toMcpCall(statement)` | One `PlurnkStatement` AST node | Canonical `McpToolCallPayload` (`{ server, tool, arguments, aside? }`) for `assistant` `toolCalls` replay. |
| `PlurnkParser.stringify(statements)` | `readonly PlurnkStatement[]` | Blank-line-separated `<server>.<tool>({}) // aside` source lines for `ops://` reflection. |
| `PlurnkParser.NO_VALID_EXPRESSION` | Constant diagnostic string | `"No valid MCP tool calls detected."` sentinel for empty/unparsed wire tool-call turns. |
| `parsePath(raw, pos?)` | Single target path or URI string | `null` on `""`, `{ kind: "local", raw, fragment? }` on bare paths, or WHATWG-decomposed `UrlPath` preserving brace globs (`PlurnkParseError` on invalid URI, {§path-syntax}). |
| `targetMembers(raw, options?)` | Authored target string | Splits top-level multi-target groups while preserving brace/bracket/paren globs and escaped delimiters ({§slot-order}). |
| `plurnk-parser [file]` | File path, `-` / omitted `stdin`, or `--help` | Prints `PlurnkParser.parseStatements` JSON (`RegExp` rendered via `.toString()`); exits `0` when error-free, `1` on any parse error. |

## §parser-lowering MCP call lowering, tier recovery, and canonical serialization

`McpExpressions`, `CallExpressionParser`, `OptionCoercion`, `StatementLowering`, `ScopeSyntax`, `MatcherSyntax`, and `ExpressionSerializer` share one lowering and projection pipeline ({§mcp-expressions}, {§op-shapes}, {§parse-recovery}):

| Stage | Contract |
| --- | --- |
| Envelope & wire recovery (`McpExpressions`) | Parses JSON-stringified `arguments`, unwraps nested `{ server, tool, arguments }` envelopes, hoists non-colliding sibling keys, and on the `"model"` tier recovers implicit wire tool names (`plurnk.<tool>`, `mcp__<server>__<tool>`, `<exec>__<tool>`, unambiguous core/executor bare names) plus DSML and XML `<parameter>` spillover; unknown or colliding tool names and malformed JSON emit `PlurnkParseError` (`operationOmitted: true`) with canonical `mcp(...)` recovery. |
| Statement & option lowering (`CallExpressionParser`, `OptionCoercion`, `StatementLowering`) | Parses `await <server>.<tool>(...)` call chains and trailing `//` asides, normalizes executor/tool spellings and parameter aliases, validates line/hash `range` markers (`ScopeSyntax`) and regex/glob/JSONPath/XPath/FTS/symbol `pattern` matchers (`MatcherSyntax`), expands multi-member targets with deduplicated inline side-notes, and emits typed `PlurnkStatement` AST nodes. |
| Canonical projection (`ExpressionSerializer`) | Projects every `PlurnkStatement` variant back to `McpToolCallPayload` (`toMcpCall`, escaping unbracketed regex `/` delimiters and normalizing multiline asides) and JSON-escaped `<server>.<tool>(...)` source (`stringifyStatement` / `PlurnkParser.stringify`) that round-trips losslessly through `parseStatements`. |

## §parser-build Consumer boundary, build projection, and installation gate

| Boundary | Contract |
| --- | --- |
| Importers | Only the service's execution path (`plurnk-core`, `plurnk-acp`, `plurnk-mcp`, `plurnk-execs`) imports `@plurnk/plurnk-parser`; `@plurnk/plurnk-contracts` and `@plurnk/plurnk-providers` declare no dependency on `@plurnk/plurnk-parser`, `xpath`, or `json-p3`. |
| Build & tarball smoke | `npm run build` compiles `dist/` cleanly; `npm run test:installation` packs `@plurnk/plurnk-contracts` and `@plurnk/plurnk-parser`, installs them in a clean consumer, and verifies `PlurnkParser`, `parsePath`, the `plurnk-parser` CLI, and `esbuild` browser bundling. |
