# PLURNK Contracts Specification

## §contract-representations 1. Overview and schema representations

`@plurnk/plurnk-contracts` is the single authority for PLURNK's model-facing contract, JSON Schemas (`schema/*.json`), generated TypeScript types, and runtime-neutral wire envelopes. `@plurnk/plurnk-parser` implements lowering and serialization between wire `mcp` tool calls, protocol statements, and `PlurnkStatement` ASTs ({§parser-build}).

| Surface | Canonical export or artifact |
| --- | --- |
| AST, validators, Problems, results, Notices, text regions and extents | `@plurnk/plurnk-contracts` |
| Capability admission and approval ownership | `CapabilityPolicy`, `SessionOwner`, `ProposalPolicy`, `PROPOSAL_POLICIES` |
| Durable effort and model catalog discovery | `Effort`, `EFFORTS`, `ModelRoute`, `ModelCatalogQuery`, `ModelCatalogPage`, `ModelReadiness` |
| Stopped-world proposals and client interactions | `ProposalDisposition`, `ProposalProjection`, `ClientInteractionRequest`, `ClientInteractionProjection`, `ClientInteractionResolution` |
| Client capability presentation | `ClientDisplayCapabilities` |
| Daemon module application port (package dependency-direction seam) | `ApplicationPort`, from `@plurnk/plurnk-contracts/port` |
| Workspace MCP and Agent Skills definitions | `McpServerDefinition`, `McpOAuth`, `SkillDefinition` |
| Session Functionality lifecycle projections | `FunctionalityProvenance`, `FunctionalityCandidate`, `FunctionalityDiscoverQuery`, `FunctionalityDiscoverResult`, `FunctionalityDefinitionState`, `FunctionalityListResult`, `FunctionalityMutationResult` |
| ACP discovery manifest | `AcpDiscovery` |
| JSON Schemas and JSON rendering | `@plurnk/plurnk-contracts/schema/*.json`, `renderJsonResult`, `formatJsonDocument` |
| Session operating card | `plurnk.md` in the package |

```mermaid
flowchart LR
    wire["Wire mcp tool calls<br/>{ server, tool, arguments, aside? }"]
    stmtSrc["Protocol & ops:// statements<br/>&lt;server&gt;.&lt;tool&gt;({ ... })"]
    parser["Lowering & serialization<br/>McpExpressions.ts · ExpressionSerializer.ts"]
    ast["Typed, serializable AST<br/>PlurnkStatement"]
    runtime["Runtime owners<br/>execution, replay & ops:// reflection"]
    wire -->|"lowerMcpCall"| parser
    stmtSrc -->|"parseStatements"| parser
    parser --> ast
    ast --> runtime
    ast -->|"toMcpCall"| wire
    ast -->|"stringify"| stmtSrc
```

| Layer | Owner or artifact | Contract |
| --- | --- | --- |
| Stable current law | `SPEC.md` | Owns invariants and boundaries; forge issues retain history |
| Session operating card | `plurnk.md` | Minimal operating guidance injected into `definition` |
| Lowering & serialization | `McpExpressions.ts`, `CallExpressionParser.ts`, `OptionCoercion.ts`, `StatementLowering.ts`, `ExpressionSerializer.ts`, `MatcherSyntax.ts`, `ScopeSyntax.ts`, `TargetSyntax.ts` | Lowers wire `mcp` tool calls (`lowerMcpCall`), inbound `/mcp` tool calls (`lowerToolCall`), and client/internal MCP statement blocks (`parseStatements`) into `PlurnkStatement` ASTs, projects statements to `McpToolCallPayload` (`toMcpCall`), and renders canonical MCP expressions for `ops://` (`stringify`) |
| Typed admission | `PlurnkStatement` AST | Produces JSON-serializable unions and validates deterministic path/scope/matcher syntax |
| Shared wire data | `schema/*.json` | Defines runtime-neutral data shapes projected into generated TypeScript |
| Stateful behavior | consuming runtime | Resolves addresses, permissions, selection arithmetic, effects, and lifecycle |

- **Authoritative representations**: JSON Schema is authoritative for shared wire data shapes; TypeScript types are generated from `schema/*.json`; `@plurnk/plurnk-parser` is authoritative for lowering `mcp` tool calls and statement blocks into `PlurnkStatement` ASTs.
- **ACP discovery and schema enforcement**: `AcpDiscovery` enumerates the installed ACP v2 actions (`scope`, `inputSchema`, `outputSchema`), notifications (`payloadSchema`), and `display` capabilities. Boundary validators enforce these schemas without mutating them and report structured validation `issues` in RFC 9457 Problem `detail`.
- **JSON result and document presentation**: `renderJsonResult` formats compact aggregate operation rows (placing top-level array items on individual lines without rewriting stored JSON coordinates). `formatJsonDocument` performs two-space whitespace-only formatting of complete strict JSON documents before representation storage.

### §capability-policy-cascade Capability admission, proposals, and model catalog

```mermaid
flowchart LR
  S["Service CapabilityPolicy"] & W["Workspace CapabilityPolicy"] --> E["Effective intersection (deny > only > allow)"]
  E --> D{"Admitted?"}
  D -->|no| R["403 capability-denied"]
  D -->|yes, allow match| A["Auto-accepted execution"]
  D -->|yes, gated| P["ProposalDisposition (review | accept | reject)"]
```

| Contract | Shape invariant | Runtime responsibility |
| --- | --- | --- |
| `CapabilityDescriptor` | One routed operation demand with its operation, access class (`read \| write \| exec \| network \| session \| interact`), resource/runtime/tool coordinates, and declared traits | Derive every demand before dispatch |
| `CapabilityPolicy` | Exact `allow`/`only`/`deny` selectors; omitted `only` is unrestricted, present empty `only` denies all, and `allow` pre-approves admitted proposals | Intersect service and workspace policies |
| `CapabilityProjection` | Durable `service`, client-mutable `workspace`, and normalized `effective` policies | Expose effective authority without storing session/loop policy copies |
| `ProposalPolicy` | `review`, `accept`, or `reject` (`PROPOSAL_POLICIES`) | Read the server's disposition knob at the proposal boundary |
| `ProposalDisposition` | Review, or automatic accept/reject with optional outcome | Select once for the pending gate |
| `ProposalProjection` | Identity, review target, body/attrs, owner, capability selector, ACP v2 subject, stale signal, disposition | One validated projection for live delivery and reconnect |

- **Exact selector conjunction**: A capability selector matches a `CapabilityDescriptor` when every declared field equals the descriptor and every declared `trait` occurs in the descriptor's trait set. Within a policy layer, `deny` wins over `only` and `allow`; when `only` is present, at least one selector must match. An empty policy admits everything; an empty `only` list admits nothing.
- **Subtractive cascade**: Capability admission is purely subtractive and order-independent: a descriptor is admitted only when every active layer (`service` and `workspace`) admits it. Workspace policy cannot restore authority denied by the service. A demand is pre-approved across layers only when it is admitted across every layer and matches at least one layer's `allow` selector. Log/program control (`kill` on `log:///...`, native dispositions `wait`/`note`, `done`, `fail`, and targetless `send`) creates no capability demand.
- **Proposals and session ownership**: `ProposalPolicy` (`review | accept | reject`) and `SessionOwner` (`address`, `clientTools`, `interactive`) govern stopped-world approval after capability admission succeeds.
- **Effort and model catalog wire**: `Effort` is `off | adaptive | low | medium | high | xhigh | max`. `ModelRoute`, `ModelCatalogPage`, and `ModelReadiness` expose provider/model identity, capabilities (including supported `efforts`), physical limits, and alternative required environment-variable name sets (names only, never values, credentials, or tuning internals).

### §provider-request-accounting Client interactions and provider request accounting

| Contract | Shape invariant |
| --- | --- |
| `ClientInteractionRequest` | Non-empty `toolName`, `mode: "form"` with non-empty `message` and object `requestedSchema`, or `mode: "url"` with non-empty `message`, non-empty `elicitationId`, and URI `url` |
| `ClientInteractionProjection` | Positive interaction, session, loop, and turn identities plus the exact request; workspace scope remains the containing transport envelope |
| `ClientInteractionResolution` | Exactly `{ action: "accept", content? }`, `{ action: "decline" }`, or `{ action: "cancel" }` |

| Projection | Complete total | Known subtotal |
| --- | --- | --- |
| Tokens (`ProviderUsage`) | Each `usage` field (`inputTokens`, `outputTokens`, `totalTokens`, cache and reasoning details) is present only if every request reports that quantity; `totalTokens === inputTokens + outputTokens` when all three are present | `knownUsage` sums each reported non-negative safe-integer field, omitting wholly unknown quantities without substituting zero for unknown |
| Monetary (`ProviderCost`) | `costUsd` is `null` if any request lacks USD-expressible cost (`charged` or `estimated` decimal string; `unknown` requires a `reason`) | `knownCostUsd` sums expressible USD costs as an exact decimal string, or is `null` when none are known |

- **Indivisible request accounting and evidence**: `ProviderRequestAccounting` binds one physical request's provider, model, outcome, optional protocol status, `ProviderUsage`, and `ProviderCost` in issue order across retries and capacity failover; a later response never replaces an earlier request. JSON-serializable forensic response/failure payloads travel alongside as separate evidence without entering client events.

---

## §mcp-expressions 2. Universal `mcp` wire tool and internal statement form

```json
{
  "name": "mcp",
  "parameters": {
    "type": "object",
    "required": ["server", "tool", "arguments"],
    "properties": {
      "server": { "type": "string" },
      "tool": { "type": "string" },
      "arguments": { "type": "object", "additionalProperties": true },
      "aside": { "type": "string", "description": "Optional terse intent note." }
    },
    "additionalProperties": false
  }
}
```

- **Universal `mcp` wire tool**: Every emission-capable model turn exposes a single native wire tool named `mcp` taking `{ server, tool, arguments, aside? }`. `plurnk` is the built-in MCP server (`read`, `find`, `edit`, `copy`, `move`, `kill`, `note`, `work`, `fork`, `bare`, `send`, `done`, `fail`, `wait`, runtime tools `sh`, `js`, `python3`, and Functionality tools `env`, `mcp`, `members`, `personas`, `schedule`, `skills`, `question`). External MCP servers are peer `server` names (`server: "<mcp>"`, `tool: "<tool>"`).
- **Statement protocol and `ops://` representation**: Client-authored `/script` blocks and `ops://` turn-source archives use `<server>.<tool>({ ... }) // aside` statement syntax (`gitea["issue-read"]({ ... })` for non-identifier tool names), parsed by `PlurnkParser.parseStatements` and rendered by `PlurnkParser.stringify`.

### §expression-boundaries Wire tool lowering, standalone runtime routing, and replay projection

| Rule | Contract |
| --- | --- |
| `lowerMcpCall` envelope lowering | `PlurnkParser.lowerMcpCall({ name, arguments }, options)` requires `name === "mcp"`, decodes object or JSON-stringified `arguments`, resolves `server` and `tool` (tolerating `function` for `tool` and `args`/`params` or hoisted sibling keys for `arguments`), and dispatches to `lowerToolCall` on the `"model"` tier. |
| Standalone runtime default tool | Passing `server: "sh" \| "js" \| "python3"` (or a built-in alias `bash`/`shell` $\to$ `sh`, `ts`/`javascript`/`typescript`/`node` $\to$ `js`, `python`/`py` $\to$ `python3` when not shadowed by an explicit executor) routes any non-path `tool` name directly to that standalone runtime (`text` / `command` / `code`), while path-shaped `tool` names (`*.py`, `dir/script.sh`) bind `script`. |
| Case-insensitive method recovery | Uppercase or mixed-case core/runtime tool names recover silently to their lowercase canonical tool name. |
| Structured replay & `ops://` serialization | `PlurnkParser.toMcpCall(statement)` projects any `PlurnkStatement` to `{ server, tool, arguments, aside? }` for structured `assistant` `toolCalls` replay; `PlurnkParser.stringify(statements)` renders JSON-escaped canonical `<server>.<tool>({ ... }) // aside` lines for `ops://` storage. |

### §slot-order Argument shapes, target groups, and endpoint options

| Construct | Contract |
| --- | --- |
| Object and positional argument forms | Core operations accept their canonical `{ ... }` options object (`{ path, range?, pattern?, text?, ... }`) as well as positional shorthands on `parseStatements`. |
| Target groups and multi-target lists | `read`, `find`, and `kill` accept `path` or `paths` as a string or array of strings; comma/pipe/whitespace-separated `scheme://` URI lists and comma/pipe-separated local path/glob lists outside brackets/braces expand into one statement per target in authored order. |
| `note` annotation on retrievals | Providing `note` on `read` or `find` emits a preceding `note` statement before the retrieval(s). |
| Endpoint and message options | `headers` (`Record<string, string>`) passes HTTP(S) request headers on `read`, `find`, `edit`, `send`, `kill`, and `copy`/`move` (`fromHeaders`/`toHeaders`); `remote` (`boolean`) confirms remote HTTP `DELETE` on `kill`; `attachments` (`string[]`) attaches resources to `send`, `done`, and `fail`. Unknown option keys (outside benign metadata keys) are refused with a parser diagnostic. |
| Operation aside | `aside` on `mcp` tool calls (or trailing `// aside` on `parseStatements`, plus `description`/`explanation`/`comment` options on the model tier when `aside` is absent) is captured into `aside` (`string` or `null`). |

---

## §op-shapes 3. Per-operation semantics and dispositions

| Server & tool | Target field | Scope / matcher / endpoint fields | Content / payload fields |
| --- | --- | --- | --- |
| `plurnk` / `find` | required `path` / `paths` | optional `range`, `pattern`, `headers` | optional `note` normalized to preceding `note` |
| `plurnk` / `read` | required `path` / `paths` | optional `range`, `pattern`, `headers` | optional `note` normalized to preceding `note` |
| `plurnk` / `edit` | required `path` | `range` or `pattern` or `oldText`/`newText` or `edits` for existing target; `text` alone creates; optional `headers` | `text` (or tolerated `content`, `replacement`, `newText`, `body`), or `edits` array |
| `plurnk` / `copy`, `move` | required `from` and `to` | optional `fromRange` / `toRange`, `fromHeaders` / `toHeaders` | none |
| `plurnk` / `sh`, `js`, `python3` | optional `script`, `cwd` | none | `text` (or tolerated `code` / `command` / `cmd` / `body` / `source` / `prompt`), optional `args` |
| `plurnk` / `<functionality>` | tool name (`env`, `mcp`, `members`, `personas`, `schedule`, `skills`, `question`) | none | JSON arguments object |
| `<server>` / `<tool>` | external MCP `<server>` and `<tool>` | optional `range` | JSON arguments object |
| `plurnk` / `bare` | none | none | required `text` (or tolerated `prompt` / `body` / `content` / `message`) |
| `plurnk` / `work`, `fork` | optional `target` (`session://name`) | none | required `text` (or tolerated `prompt` / `body` / `content` / `message`) |
| `plurnk` / `kill` | required `path` / `paths` | optional `range`, `pattern`, `remote`, `headers` | optional `note` distillation on `log:///` |
| `plurnk` / `send` | optional `target` recipient (caller aliases `user`/`client`/`human`/`operator`/`caller` normalize to `null`) | optional `headers`, `attachments` | required `text` message body |
| `plurnk` / `done` | optional `target` (`message://`; caller aliases normalize to `null`) | optional `attachments` | `text` final deliverable (required in tool schema; parser tolerates empty to resolve silently) |
| `plurnk` / `fail` | optional `target` (`message://`; caller aliases normalize to `null`) | optional `attachments` | `text` final failure explanation (required in tool schema; parser tolerates empty to cancel silently) |
| `plurnk` / `note` | none | none | `text` conclusions, findings, and plans |
| `plurnk` / `wait` | none | optional `seconds` | none (tolerated `text` normalizes to `aside`) |

- **Retrieval annotations**: Nonblank `note` options on `find` or `read` normalize into a preceding `note` statement.
- **Text range algebra**: `"N"` selects whole line `N` (`"0"` prepends, `"-1"` appends on mutation); `"N,M"` selects inclusive lines `N..M`; `"SL,SC,EL,EC"` selects an exact 1-based Unicode code-point region with exclusive end (three-integer ranges normalize to four).
- **Local path fragments**: Bare paths decompose `#channel` into `fragment` just like `scheme://` URLs so channel selectors round-trip identically.
- **Turn dispositions (`wait`, `done`, and `fail`)**: Dispositions may appear anywhere in a turn; multiple `wait` statements coalesce to the shortest `seconds` bound, and `done` (`200`) or `fail` (`499`) resolves an Open Message once all earlier operations in the turn settle.

---

## §path-syntax 4. Target and path grammar

- **URL vs. local path decomposition**: Targets matching `[a-z][a-z0-9+._-]*://` decompose via WHATWG `URL` into `UrlPath` (preserving lossless serialized `query` and `fragment`); all other targets become `LocalPath { kind: "local", raw, fragment? }`.
- **Parenthesis tolerance and backslash escaping**: Literal parentheses render verbatim in targets and receipts; `%28`/`%29` in pathnames decode to `(` / `)`, and `\\`, `\(`, `\)` unescape losslessly via `PathSyntax`.
- **Glob classification and session names**: `PathSyntax.hasGlob` and `globMagicIndex` classify glob metacharacters vs. exact paths. `SESSION_NAME` (`[A-Za-z0-9][A-Za-z0-9_-]{0,62}`) validates minted session authority names (excluding `_plurnk`).

---

## §matcher-prefix-claims 5. Bulk pattern matching and scope markers

`find`, `read`, `kill`, and `edit` accept a `pattern` matcher classified by leading sigil (`glob` and `regex` may span multiple lines; `xpath`, `jsonpath`, `fts`, and `graph` are single-line):

| Prefix | Dialect | Validation & tolerance |
| --- | --- | --- |
| `//` | `xpath` | Validated with XPath 1.0 parser before regex classification (also silently normalizes single-slash absolute XPath location paths such as `/root/item[@id='old']/@id` or `/root/item/text()`, regex-wrapped or trailing-slash XPath selectors, and vacuous `/text()` after `@attr` steps) |
| `/` or `^` | `regex` | ECMAScript `RegExp` (escaped pipe is literal, unescaped pipe is alternation); tolerates PCRE `\A`/`\z`/`\Z` anchors, trailing `-flags`, `/~.../` mixed prefix, unbalanced unescaped `(`, `)`, or `[`, and glob-shaped `/*text*/` |
| `$` | `jsonpath` | Validated with RFC 9535 `json-p3` |
| `~` | `fulltext` | Single-line FTS5 query string |
| `&` | `graph` | `&symbol`, `&<symbol`, or `&>symbol` relation query |
| none | `glob` | Fallback shell glob or single/multiline literal substring |

- **Soft matcher refusal**: An invalid matcher expression is admitted as `matcher.dialect = "unreadable"` with its diagnostic and working-form `recovery` so only that operation fails `400 grammar/matcher/unreadable-pattern` while sibling statements in the turn still execute.
- **Statement recovery and argument tolerances**: Statement errors fail only the offending call while admitting valid sibling calls; an inline `<L,M>` range written inside `path<L,M>` is lifted on the model tier.
- **Line anchors and range recovery**: `TextLineMarker` accepts `@<5 Base62 chars>` line anchors (with optional `[+-]K` offsets or surrounding `<...>`) in line positions; reversed or count two-number ranges (`"M,N"` with `M > N`, `"N,+K"`) and unambiguous anchor forms (`"@hash,1"` as `"@hash"`, `"@hash,0"` as `"@hash,1,@hash,1"`, and `"@start,@end,SC[,EC]"` as `"@start,SC,@end[,EC]"`) normalize silently on the model tier.

---

## §whitespace-contract 6. Parser architecture, whitespace, and public API

- **Structured lowering and statement parsing**: `PlurnkParser.lowerMcpCall` lowers a structured `mcp` wire tool call into `statement` and `error` items; `PlurnkParser.parseStatements` parses client/internal statement blocks without prose interleaving.
- **Tier entry points and runtime-neutral root**: `PlurnkParser.lowerMcpCall` (model wire tool call), `PlurnkParser.lowerToolCall` (inbound `/mcp` tool call), `PlurnkParser.parseStatements` (protocol/internal statements), `PlurnkParser.toMcpCall` (structured `mcp` tool-call projection), and `PlurnkParser.stringify` (canonical statement rendering) are exported by `@plurnk/plurnk-parser`. The `@plurnk/plurnk-contracts` root is closed (verified by `src/index.test.ts`) and browser/DOM runtime-neutral (`tsconfig.browser.json`), with Node HTTP host types isolated in `@plurnk/plurnk-contracts/port`.

---

## §text-region 7. Runtime-neutral wire contracts, text regions, and entry reads

| Contract | Fields & Invariants |
| --- | --- |
| `TextRegion` | `{ startLine, startColumn, endLine, endColumn }` — 1-based positive safe integers counting Unicode code points (`LF`, `CRLF`, `CR` line separators; `CRLF` is one indivisible separator). `end` is exclusive; equal start and end identify a zero-length insertion point. Validated by `Validator.assertTextRegion`. |
| `RangeExtent` | `{ unit: "line" \| "result" \| "byte", total, requested: [first, last], returned?: [first, last] }` — `requested` preserves the numeric request; `returned` names inclusive positive ordered positions (`<= total`) and is omitted on empty or failed selections. Validated by `Validator.assertRangeExtent`. |
| `EntryReadResult` | `{ status: 200, entry: ClientEntry } \| { status: 400..599, problem: ProblemDetails, entry: null }` — `ClientEntry` carries `{ entryId: number \| null, target: string, channels: Record<string, ClientEntryChannel> }`. Every returned channel (`content`, `contentOffset`, `contentLength`, `mimetype`, `weight`, `state: "static" \| "active" \| "closed" \| "errored"`) satisfies `contentOffset + codePointLength(content) === contentLength`. |

### §diagnostic-observation Operation results, Problem Details, and Notices

| Envelope / Method | Contract |
| --- | --- |
| `OperationResult` | Status `100..399` forbids `problem`; status `400..599` requires one RFC 9457 `ProblemDetails` object whose `status` equals the containing operation status. |
| `ProblemDetails` | Requires `type` (stable absolute URI), `title` (stable summary with no occurrence data), `status`, and `detail` (failed subject, observed fact, and violated constraint); optional `instance`, `stage`, `recovery` (one working-form next action), `retryable`, and factual producer extensions. |
| `Problems.fromError(error)` | If `error.result` is present, validates the complete `OperationResult` and returns its `problem`; otherwise if `error.problem` is present, validates and returns `ProblemDetails` unchanged; otherwise returns `null`. |
| `Problems.project(problem, context)` | Produces `ProblemProjection` for model packets: retains `type` and `detail`, retains `stage`/`recovery`/`retryable`/extensions when not duplicated by the enclosing row, and strips `title`, `status`, and `instance`. |
| `Notice` | Transient, non-terminal observation (`level`, `source`, `kind`, `message`, optional `directive` starting with `YOU MUST` / `YOU MUST NOT` / `YOU MUST ONLY` / `YOU SHOULD` / `YOU SHOULD NOT` for model-output advisories). |

- **Diagnostic observation**: Every Problem `detail` and `recovery`, parse diagnostic, and `Notice` states what was read, what was done with it, and where, and may show the working form of the construct it read or refused — never guessing author intent or why.

### §mcp-server-definition Client display capabilities, MCP servers, and skills

- **`ClientDisplayCapabilities`**: Ordered array of closed discriminated objects (`{ kind: "scheme", scheme, display }` or `{ kind: "mimetype", mimetype, display }`), where `display.glyph` is an optional non-empty opaque string.
- **`McpServerDefinition` and `McpOAuth`**: Closed union of `stdio` (`command`, optional `args`, `env`, `cwd`, `plurnkWorkspace`, `plurnkSession`) and `streamable-http` (`url`, optional `headers`, `authorization`, `plurnkWorkspace`, `plurnkSession`) definitions. `McpOAuth` (`Validator.assertMcpOAuth`) validates interactive OAuth (`callbackUrl`, mutually exclusive HTTPS Client ID Metadata Document URL / pre-registered client ID + `${NAME}` secret / Dynamic Client Registration, optional `issuer` and `authorizationParams`) and `client_credentials` grants.
- **`SkillDefinition`**: Workspace skill definition (optional `source`, `ref`, `commit`; skill alias validated against `SKILL_NAME`) validated by `Validator.assertSkillDefinition`.

### §application-session-observation Daemon application port and session/loop observation

| Projection / Helper | Contract |
| --- | --- |
| `ApplicationPort` | Transport-neutral interface in `@plurnk/plurnk-contracts/port` driving workspaces, sessions, loops (`runLoop` with causal `source`, `attachments`, `envelope`), operations, proposals, client interactions, and filtered event subscriptions (`subscribeToEvents(handler, filter?)`). |
| `DaemonNotification` / `NotificationFilter` | Closed discriminated union over the 19 `DAEMON_NOTIFICATION_EVENTS` (`{ id, event, timestamp, workspaceId, sessionId, data }`), constructed by `toDaemonNotification` and filtered at source by `matchesNotificationFilter(notification, { events?, workspaceId?, sessionId? })`. |
| `admitBearerRequest` | Runtime-neutral OAuth 2.1 Bearer and optional `?access_token=` admission helper over `CredentialAuthority` returning `{ ok: true, family, subject }` or `{ ok: false, problem, challenge }`. |
| `selectSessionLoop` | Chooses `running` before `parked` before `queued` (oldest unresolved sequence wins ties); with no live work, the latest terminal settlement wins. Maintenance-only loops do not change this projection. |
| `lifecycleOfLoopStatus` | Maps loop status to client lifecycle vocabulary: no loop `idle`; `100` `queued`; `102` `running`; `202` `parked`; `< 400` `completed`; `499` `cancelled`; `>= 400` `failed` (`413` budget, `429` turn ceiling, `500` fail, `504` timeout, `508` runaway). |
| `excerptOf` | Extracts the first non-blank line of a message truncated to at most `N` code points without splitting a character, with trailing whitespace trimmed and `continued: boolean`. |
| `ApplicationSessionOverview` | Projects non-archived model-origin sessions (`{ workspaceId, id, name, parentSessionId, kind, lifecycle, gates, reply, title }`) ordered by most recently finished reply row first, then newest unreplied sessions, always including all gated sessions before applying `limit` and reporting `omitted`. |

---

## §parse-recovery 8. Argument tolerances and error shapes

`PlurnkParseError` is a JSON-serializable `Error` carrying `{ line, column, source: "lexer" | "parser" | "visitor", severity: "error" | "warning", recovery?, attempt?, operationOmitted }`:

| Representation | Line | Column | Absence or extent |
| --- | --- | --- | --- |
| Parser/AST `Position` | 1-based | 0-based Unicode code points | `UNKNOWN_POSITION = { line: 0, column: 0 }` is the sole unknown sentinel |
| Notice `content-offset` | 1-based | 0-based Unicode code points | Omit or set `position` to `null` when unknown |
| Contracts `TextRegion` | 1-based | 1-based Unicode code points | Start included, end excluded; equality is zero-width |
| SARIF 2.1.0 region | 1-based | 1-based (`columnKind: "unicodeCodePoints"`) | End excluded; parser point adapters add 1 to `column` |

| Mechanism | Contract |
| --- | --- |
| Working-form recovery & attempt | Every hard error (`severity: "error"`) populates `recovery` with the working `mcp({ server, tool, arguments })` form of the refused construct and `attempt` (`{ text, verb }`) with the refused call's source text; `operationOmitted` marks unexecuted calls. Each malformed call produces at most one hard error. |
| Regex and matcher tolerances | Lifts leading PCRE inline flags `(?ims)` with a warning; recognizes unslashed line-anchored regexes opening with `^` or closing with `$`; folds comma-separated `/pattern/` lists on `find` and `read` into alternation with a warning while refusing numeric/open sed ranges (`/a/,+N`, `/a/,-1`, `/a/,`) and mutating `/a/,/b/` ranges; diagnoses trailing text after `/pattern/flags`; recovers unclosed `/pattern` at EOL; and on `edit`, normalizes unreadable single-line literal code patterns starting with `//`, `$`, `&`, or `/` (when an interior `/` is followed by non-flag literal text rather than `/pattern/flags`) into exact literal matchers. |
| Argument tolerances | Deterministically canonicalizes near-miss wire tool names (`mcp__<server>__<tool>`, `<server>.<tool>`, `<server>__<tool>`, or bare `plurnk` tool/builtin-executor names), `mcp` payloads with dotted `tool: "<server>.<tool>"` or omitted `server: "plurnk"`, nested tool calls routed through `plurnk.mcp` (`{ server\|name\|alias, tool\|function, arguments? }` without MCP server configuration keys), DSML invoke-boundary `<｜DSML｜parameter name="...">` leaks inside `server` or `tool`, and separate `channel: "#<name>" \| "<name>"` options on resource-targeting operations (folded onto fragmentless target paths as `path#channel`); lifts inline `<L,M>` ranges from `path<L,M>` strings with a warning; recovers bare `edit` anchors (`@abcde`), combined `42<@abcde>` ranges, trailing commas in range lists (`"17,18,"`), unbalanced angle brackets around `@hash` ranges (`"<@abcde,@fghij"`), anchor-first column tuples (`"@SL,@EL,SC[,EC]"`), and packet-header line counts (`"N lines"`); and unwraps nested parameter wrappers (`params`, `parameters`, `arguments`, `args`, `input`, `options`, `properties`). |
