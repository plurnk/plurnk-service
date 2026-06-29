# Plurnk Grammar Specification

## 1. Overview

Plurnk extends HEREDOC formatting into a state-machine grammar for LLM
agents. Every plurnk statement is a single self-contained operation: a
canonical open tag, an optional payload, and a colon-fenced opaque body
terminated by a matching close tag. Statements are flat — there is no
composition or substitution. Documents may contain arbitrary
interstatement text, which the parser captures verbatim and surfaces
to consumers without imposing meaning on it.

The parser produces a typed AST (per OP discriminated union) plus a
list of structured errors. Both are JSON-serializable. Errors are
per-statement; the parser recovers at statement boundaries when it
can, and surfaces an `unparsedTail` when a boundary-destroying error
prevents further recovery. See §12 for the consumer contract.

Note: SEND status codes (§9) are a *protocol-level* convention for
SEND statements emitted by the model and runtime. They are unrelated
to parse-time `PlurnkParseError` objects produced by this package (§12).

## 1.1 Domain Boundary

The grammar is purely syntactic. A rule belongs in the grammar if and
only if it can be expressed as a shape constraint on character
sequences. A rule has crossed into runtime as soon as it requires any
of:

- **Variables** — state held across statements, named bindings, references to prior values.
- **Magic numbers** — values that carry semantic weight (`410` means "Gone," `200` means "OK"); the grammar accepts the digit string, not its meaning.
- **Embedded code** — executing language fragments to determine well-formedness (compiling a regex, validating an xpath, resolving a URI).

Anything that fits inside that constraint belongs in `.g4`. Anything
that needs interpretation belongs in the runtime resolver.

**Concretely in domain — parser-managed (lexer + parser):**

- Statement structure: open tag, slots, body, close tag.
- Lexical tokens: `<<`, OP keywords, `[…]`, `(…)`, `<N>`, `:`, body, close tag, interstatement TEXT.
- Slot *shape* constraints: URI shape (scheme grammar + path character class), line-marker integer form, suffix character class, CSV form of `[signal]`.
- HEREDOC discipline: open/close tag character match, body opacity between `:body:` fences, nesting via suffix.
- Whitespace rules (§11).
- Hard constraint: `:OPsuffix` close tag must character-match the open tag's `OPsuffix`.

**Concretely in domain — Visitor-managed (typed AST construction):**

- Extracting `op`, `suffix`, `signal` (split on comma), `path` (raw),
  `lineMarker` (parsed `<N>` or `<N-M>` integer form), and `body` (raw)
  from the parse tree into a typed discriminated union.
- Native-JS validation of slot contents where useful (e.g., `new URL()`
  for path, `new RegExp()` for regex bodies). This is preferred over
  ANTLR sub-grammars for URI/regex/xpath/jsonpath — Node's built-ins are
  authoritative, well-tested, and zero-cost to invoke.

**Concretely out of domain — runtime:**

- URI resolution: what `known:///`, `unknown:///`, `file://` actually point at; what bare paths resolve to.
- Tag-matching combination (AND/OR), tag-set semantics.
- Line-marker arithmetic, out-of-range handling, result-set ordering for pagination.
- Status code *meanings*: any digit string is grammatically valid in `[signal]`; whether `[410]` means "Gone" or any code carries privileged semantics on any OP is runtime convention.
- Empty-body semantics (e.g., empty EDIT clears the entry).
- EXEC body execution: runtime selection, sandboxing, permissions.
- Filter composition (how OPEN/FOLD combine path × tag × body filters).
- Output shape returned to the model after a statement executes. The §4 Per-OP Output table documents convention, not grammar rules.

## 2. Canonical Statement Form

```
<<OPsuffix [signal]? (path)? <L>? : body? :OPsuffix
```

The `:` characters fence the body. Everything between the opening `:`
and the closing `:OPsuffix` literal is body, verbatim. This is what
makes plurnk solve grammatical enclosure: body content is fully opaque
to OP keywords, modifier-like characters, and the protocol's own
syntax.

Optionality:

| Element     | Status        |
|-------------|---------------|
| `<<`        | required      |
| `OP`        | required      |
| `suffix`    | optional; used for nesting and `:OPkeyword` escape (see §8) |
| `[signal]`  | optional, OP-dependent contents |
| `(path)`    | required for all OPs except SEND (recipient) EXEC (cwd), and PLAN (no operand), where it is optional |
| `<L>`       | optional; single position or range (see §7) |
| `:`         | required (header → body delimiter) |
| `body`      | optional, OP-dependent meaning |
| `:OPsuffix` | required (close tag: `:` + open tag's OP and suffix, character-matching) |

Hard constraints:

- Close-tag `:OPsuffix` must character-match the open tag's `OPsuffix`.
- Header elements appear in the order shown above (signal, then path, then `<L>`, then `:`).

All other restrictions are runtime concerns, not grammar concerns.

## 3. Lexical Elements

- `<<` — open delimiter.
- `OP` — exactly one of: `FIND`, `READ`, `EDIT`, `COPY`, `MOVE`, `OPEN`, `FOLD`, `SEND`, `EXEC`, `KILL`, `PLAN`.
- `suffix` — `[A-Za-z0-9_]*` immediately concatenated to `OP`, no separator.
- `[` … `]` — signal slot; contents are OP-dependent (see §4).
- `(` … `)` — path slot; contents are a URI (see §5).
- `<L>` — line marker. Shape: `<` `-?[0-9]+` (`-` `-?[0-9]+`)? `>`. A single signed integer denotes a position; two signed integers separated by `-` denote an inclusive range.
- `:` — body delimiter. Appears between header and body, and (with the OP+suffix following) at the close.
- `body` — opaque byte stream between the opening `:` and the matching close tag `:OPsuffix`.
- `:OPsuffix` close — `:` immediately followed by the open tag's `OP` and `suffix` (character-matching, no whitespace).

## 4. Per-OP Semantics

| OP     | `[signal]`        | `(path)` | `body`                  | `<LineN>`     |
|--------|-------------------|----------|-------------------------|---------------|
| FIND   | tag filter (CSV)  | required | pattern matcher         | result-set pagination |
| READ   | tag filter (CSV)  | required | pattern matcher         | per-entry lines |
| EDIT   | tags (CSV)        | required | content (empty body clears the entry) | entry lines |
| COPY   | tags to apply (CSV) | required | destination URI, or a fork prompt for run:// (opaque; scheme interprets) | entry lines |
| MOVE   | tags to apply (CSV) | required | destination URI       | entry lines |
| OPEN   | tag filter (CSV)  | required | optional pattern matcher | result-set pagination |
| FOLD   | tag filter (CSV)  | required | optional pattern matcher | result-set pagination |
| SEND   | HTTP status code (single integer) | optional | message payload (JSON by convention for structured responses) | not applicable |
| EXEC   | executor (single string; `sh` default, `node`, `python`, …) | optional (cwd) | command or code snippet | not applicable |
| KILL   | unix signal (single integer; wired, untaught in canon) | required | opaque annotation (logged, no runtime meaning) | not applicable |
| PLAN   | tag filter (CSV; parse-side, canon is slotless) | optional (parse-side; canon is slotless) | reasoning text (recorded to the log; no other effect) | parse-side only |

The `<L>` slot is optional. Its referent shifts by OP (per the column
above) but the syntax is uniform: a single integer denotes one
position, an integer range `<N-M>` selects items at positions `N..M`
inclusive of whatever sequence the OP operates on or produces.

EDIT line-marker semantics (single source of authority):

- No `<L>` + body present: replace entire entry contents with body.
- No `<L>` + no body: clear entry contents (empty replacement).
- `<N>` (single position) + body: replace the single line at `N` with body.
- `<N-M>` (range) + body: replace lines `N..M` inclusive with body.
- `<0>` + body: prepend body before line 1.
- `<-1>` + body: append body after the last line.

### Per-OP Output (what each OP produces)

| OP   | Produces |
|------|----------|
| FIND | list of matching paths |
| READ | content of matched entries (or matched substrings if `body` is a pattern) |
| EDIT | status; resulting entry content on success |
| COPY | status; destination path on success |
| MOVE | status; destination path on success |
| OPEN | status; list of log rows opened |
| FOLD | status; list of log rows folded |
| SEND | status; recipient ack if applicable |
| EXEC | exit code, stdout, stderr |
| KILL | status; killed path |
| PLAN | status; logged |

Output is delivered to the model in the next turn. The shape of "status"
is a SEND-style status code (see §9) so that errors are uniform across
all OPs.

## 5. Path Grammar

Paths are URI-shaped, drawn from RFC 3986 in spirit but not strictly.
Two RFC concessions justify the relaxation:

1. RFC 3986 lists `)` as a sub-delim — a valid path character. Plurnk
   reserves a literal `)` to close the path slot and provides no escape
   mechanism. A path that needs a literal paren **percent-encodes it**
   (`%28` / `%29`) — the complete, standards-aligned answer:
   `(https://en.wikipedia.org/wiki/Mercury_%28planet%29)` parses, where
   `(…Mercury_(planet))` would not. (`(` alone is fine as content; only
   `)` terminates.) A balanced-paren or escape grammar was considered and
   rejected: balanced counting is incomplete for unbalanced parens, and
   both re-complicate the deliberately-opaque target slot for a case
   percent-encoding already covers. For *matching* a parenthesized name,
   glob (`Mercury_*planet*`) or a `#…#` regex is the natural form.
2. Bulk Pattern Matching extends path segments with glob
   metacharacters (`*`, `**`, `?`, `[…]`) that fall outside the RFC
   character set.

Lexer-enforced shape:

- Optional scheme: `[a-z][a-z0-9+.-]*` followed by `://`.
- Path content: any character except `)`, `<`, and newline. A literal
  `)` closes the slot (percent-encode to embed one).
- A `#pattern#flags` regex target is recognized as a unit, bounded by
  its own `#` delimiters (`\#` escapes a literal hash), so it MAY contain
  `)` — regex groups work: `(#(draft|final)/.*#)`.
- Glob metacharacters in path segments are permitted.

Runtime-enforced semantics:

- Bare paths (no scheme) resolve as `file://` at runtime.
- Conventional schemes include `known:///`, `unknown:///`, `log:///`,
  `file://`, `http://`, `https://`. Any scheme matching the lexer
  shape is grammatically valid; resolution is a runtime concern. The
  scheme catalogue and per-scheme semantics — and their packet-time
  teaching to the model — are owned by the schemes module, not this
  grammar; that is why plurnk.md carries no scheme list.
- Percent-encoding, authority structure, port range, and other RFC
  3986 finer points are validated by the runtime URI resolver, not
  the parser.

## 6. Bulk Pattern Matching

For FIND, READ, OPEN, and FOLD, `body` is an optional pattern matcher.
The lexer captures the body opaquely (between the `:body:` fences) —
dialect dispatch is not a lexer concern. Dialect is determined by the
body's leading characters, and validated by the Visitor using native
JS facilities (`new RegExp()` etc.) where applicable. Dispatch is a
hint, not a gate: a body that fails its prefix-indicated dialect falls
back to glob instead of erroring, so literal `//`-comments,
`/path/`-strings, and `$`-prefixed text reach the runtime as glob
matches.

| Leading prefix | Dialect   | Canonical form            | Validation         |
|----------------|-----------|---------------------------|--------------------|
| `//`           | xpath     | `//…`                     | `xpath.parse()` in Visitor; glob on failure |
| `/`            | regex     | `/pattern/flags` (trailing `/` required, flags `[a-z]*`) | `new RegExp()` in Visitor; glob on failure |
| `$`            | jsonpath  | `$…`                      | `JSONPath()` in Visitor; glob on failure |
| `~`            | semantic  | `~phrase`                 | none — any text is a valid query |
| `@`            | graph     | `@symbol`, `@<symbol`, `@>symbol` | none — resolved service-side |
| otherwise      | glob      | `…` (literal substring if no metacharacters) | runtime (glob library) |

Dialect conventions (the Visitor uses these to construct typed AST
body fields; the lexer is unaware):

- Xpath body begins with `//` (descendant-or-self axis). Absolute-root
  `/foo` is unreachable (collides with regex prefix); rework as `//foo`.
- Regex body is a delimited literal: opens with `/`, ends with `/`
  before the close fence, with optional flag chars `[a-z]*` between
  the closing `/` and the close fence. Literal `/` inside the pattern
  must be escaped `\/`.
- Regex anchors `^` and `$` go inside the slashes: `/^foo$/`.
- Flag semantics (`i` case-insensitive, `m` multiline, `s` dotall,
  etc.) follow ECMAScript regex.
- Semantic body is a free-text similarity query; top-K narrowing rides
  the host statement's `<L>` slot.
- Graph body is a code-graph reference query: `@symbol` (neighborhood),
  `@<symbol` (inbound references), `@>symbol` (outbound references).
  No parse step in grammar; resolution is service-side.
- Glob is the catch-all and includes the literal-substring case when
  no metacharacters are present.

**Implemented validation in the Visitor (Node-native):**

- **Path**: the Visitor distinguishes local paths from URLs by the
  presence of a scheme prefix (`[a-z][a-z0-9+.-]*://`). Local paths
  (filesystem-style, no scheme) are stored as `{ kind: "local", raw }`
  without further parsing — `new URL()` is not invoked, so no URL
  conventions are imposed on what was clearly intended as a local
  reference. URLs are parsed by `new URL(raw)` and decomposed into
  components (`scheme`, `username`, `password`, `hostname`, `port`,
  `pathname`, `search`, `fragment`). Genuine URL-protocol violations
  (malformed authority, unterminated IPv6 brackets, invalid port, etc.)
  produce a `PlurnkParseError` with source `"visitor"`.
- **Regex body** (matcher-body OPs only, leading `/` and not `//`):
  the Visitor extracts `pattern` and `flags` (respecting `\/` escapes)
  and calls `new RegExp(pattern, flags)`. On failure (missing closing
  `/`, unterminated character class, invalid flag, etc.), the body
  falls back to a glob matcher.
- **XPath body** (matcher-body OPs only, leading `//`): the Visitor
  calls `xpath.parse()` from the `xpath` npm package (XPath 1.0
  parser-only, no DOM execution). On failure (unterminated predicate,
  invalid operator, etc.), the body falls back to a glob matcher.
- **JsonPath body** (matcher-body OPs only, leading `$`): the Visitor
  calls `JSONPath({ path: body, json: {} })` from the `jsonpath-plus`
  npm package. The empty `{}` ensures syntax parsing happens without
  document evaluation. On syntax failure (unclosed parens, malformed
  filter expressions, etc.), the body falls back to a glob matcher.

**Deferred validation:**

- **Glob** bodies — pass through as raw; runtime applies whatever
  glob matcher is appropriate.

**Why not ANTLR sub-grammars for any of these?** Node's `new URL()`
and `new RegExp()` are authoritative, well-tested, and zero-cost to
invoke; `xpath` and `jsonpath-plus` are the de facto Node parsers for
their respective dialects. ANTLR sub-grammars for any of these would
add hundreds of lines of generated parser code with no validation
benefit over the native or library facilities.

## 7. Line Markers

A line marker selects a position or range from the sequence an OP
operates on or produces. The sequence type is OP-specific (see §4
per-OP table): entry lines for EDIT/COPY/MOVE, matched content lines
for READ, positions in the matched result set for FIND/OPEN/FOLD.

**Token shape:** `<` NUM ((`-` | `,` `' '?`) NUM)* `>`, where NUM is
`-?[0-9]+(.[0-9]+)?`. One or more numeric components, comma- or
dash-separated. The parser carries the ordered list verbatim as
`LineMarker.marks: number[]`; assigning roles to the components is the
consumer's job (see arity table).

| Form     | `marks`       | Meaning (consumer interpretation)    |
|----------|---------------|--------------------------------------|
| `<N>`    | `[N]`         | single position N                    |
| `<N,M>` / `<N-M>` | `[N, M]` | inclusive range N..M               |
| `<0>`    | `[0]`         | prepend anchor (before position 1)   |
| `<-1>`   | `[-1]`        | append anchor (after last position)  |
| `<2.5>`  | `[2.5]`       | line context: insert between lines 2 and 3 (fraction value is don't-care) |
| `<0.7>`  | `[0.7]`       | result context: similarity threshold ∈ (0,1) for semantic matchers |
| `<0.7,10,20>` | `[0.7, 10, 20]` | threshold + range (score ≥ 0.7, positions 10..20) |

Examples involving negative integers:

- `<-1-5>` — `[-1, 5]` (dash separator; the following number is positive)
- `<0,-5>` — `[0, -5]` (comma separator admits a negative second number)
- `<-3,-1>` — `[-3, -1]`

**Parsing rule:** greedy. Each component consumes a leading `-` and
digits (plus an optional `.`-fraction) maximally; a `-` or `,`(` `?)
then separates the next. So `<-1-5>` parses as `[-1, 5]` — the first
`-` is the sign of -1, the second `-` is the separator. This falls out
of standard ANTLR longest-match. The dash separator is parse-side only;
the GBNF dictates the comma form.

**Runtime concerns** (not enforced by the parser):

- `N ≥ 1`: 1-indexed position.
- Validity of any specific value (out-of-range, inverted range where
  `N > M`, sentinel meanings beyond the canonical `0`/`-1`) is decided
  per-OP at runtime.
- Decimal dispatch is form-driven, like matcher-dialect dispatch: an
  integer addresses a position; a decimal addresses the space between
  (line contexts: insertion point) or above (result contexts: score
  threshold). A decimal where neither meaning applies — a threshold on
  a non-semantic matcher, a fractional position on COPY/MOVE — is
  answered with `416 Range Not Satisfiable`, not silently coerced.

**Result-set ordering** (FIND, OPEN, FOLD): the runtime must produce a
deterministic order so that `<N-M>` pagination is reproducible. The
choice of ordering is a runtime guarantee, not a parser concern.

## 8. Suffix Discipline

The `:body:` fencing handles the vast majority of grammatical-enclosure
concerns: body content is fully opaque to OP keywords and modifier-like
characters. The suffix is reserved for the residual edge case where
body content literally contains the close-tag pattern `:OPkeyword`.
That happens in two scenarios:

1. **Nesting plurnk statements inside a body** (recording a plurnk
   transcript, storing examples, etc.). The inner statement's close
   `:OP` would prematurely terminate the outer's body.
2. **Body content contains `:OPkeyword` as literal text** (e.g., a
   stored JSON object with a value mentioning plurnk syntax).

Suffix rules:

- `suffix` is `[A-Za-z0-9_]*`, concatenated to `OP` with no separator, on both open and close.
- Open `<<OPsuffix` and close `:OPsuffix` must character-match.
- A non-empty suffix on the outer statement ensures its close tag
  (`:OPsuffix`) is distinct from any `:OP` substring that may appear in
  body content (whether as nested plurnk or as literal text).
- The body of a statement cannot contain its own exact close-tag
  literal; choose a suffix that does not collide.
- Empty suffix is the default. Most statements need no suffix.
- Generation-side canon dictates **digit** suffixes (`<<EDIT1 … :EDIT1`)
  so the shipped GBNF (`dist/plurnk.gbnf`) can enumerate close tags —
  the HEREDOC tag match is not context-free. The parser remains
  permissive: any matching `[A-Za-z0-9_]*` suffix is valid.

Example — nested EDIT inside an outer EDITa:

```
<<EDITa(known:///demo):
The following is a quoted plurnk operation, preserved verbatim:
<<EDIT(known:///inner):hello world:EDIT
:EDITa
```

The inner's `:EDIT` close does not terminate the outer because the
outer's close tag is `:EDITa`.

## 9. SEND Status Codes

SEND status codes align with HTTP semantics so that model training
transfers directly:

- `1xx` Informational — continuation; `102 Processing` is the canonical loop-continuation code.
- `2xx` Success — terminal delivery; `200 OK` is the canonical final-answer code.
- `3xx` Redirection — handoff to another agent or address.
- `4xx` Client Error — model-side failure (malformed plurnk, missing path, contract violation).
- `5xx` Server Error — runtime or infrastructure failure (network, permission, tool unavailable).

SEND with no `(path)` broadcasts to the default control channel. SEND
with `(path)` directs the message at a specific recipient URI.

### Response Body Convention

Structured responses (errors, query results, multi-field acknowledgments)
are emitted as **JSON in the SEND body**, so the model can consume them
with the same jsonpath dialect it uses for matching:

```
<<SEND[400](err://lex)
{"reason":"unexpected token","position":{"line":47,"column":12},"expected":[")"],"got":"["}
SEND
```

The model retrieves a field with `<<READ(err://lex)$.reasonREAD` or
similar. Plain-text bodies remain valid for simple terminal answers
(`<<SEND[200]ParisSEND`). The JSON convention is runtime policy; the
grammar treats body as opaque.

## 10. Implementation Notes

- ANTLR4 split follows standard convention: `plurnkLexer.g4` defines
  tokens; `plurnkParser.g4` defines statement structure. Generated
  using `antlr-ng` targeting the `antlr4ng` runtime.
- The body is fenced by `:` on the header side and `:OPsuffix` on the
  close side. The lexer enters body mode when it consumes the opening
  `:` after the last header element. In body mode, the close-tag rule
  uses a semantic predicate (`atColonCloseTag()`) that fires when the
  next characters match `:OPsuffix` exactly. The open tag (`OP +
  suffix`) is captured at statement start and held on the lexer
  instance.
- The body is uniformly opaque at the lexer level (a sequence of
  `BODY_TEXT` tokens). The Visitor reconstructs body content as a
  single string and, per OP semantics, interprets it as content,
  destination URI, payload, command, or matcher.
- Header mode hierarchy: state machine `DEFAULT → OPENED → SIGNAL → POST_SIGNAL → PATH → POST_PATH → POST_L → BODY` tracks which
  header elements remain valid at each position (after signal, signal
  is no longer valid; after path, neither signal nor path; after `<L>`,
  only the `:` body delimiter is valid). Each header mode requires the
  `:` to transition to BODY; no fallback.
- PATH and SIGNAL content reject `<<` (single `<` is permitted inside
  them, double `<<` is the statement-opener prefix and must not appear).
  This prevents a malformed path or signal from silently swallowing the
  next statement.
- Interstatement content (between statements) is captured as `TEXT`
  tokens. The lexer's `TEXT` rule matches any chars that aren't a
  recognized statement opener; a `<<` followed by a non-OP sequence is
  rolled into `TEXT` rather than producing an error.
- Error model: the parser uses ANTLR's `DefaultErrorStrategy` for
  cross-statement recovery (sync to next statement opener on error).
  An error listener records every syntax error as a `PlurnkParseError`
  (line, column, source: `"lexer" | "parser"`, message). The Visitor's
  caller correlates errors to statement positions and emits them in
  the result's `items` array in order.
- Boundary-destroying errors (lexer ends in a non-DEFAULT mode at EOF,
  typically meaning a statement was never closed) surface as
  `unparsedTail` on the parse result. The agent's consumer treats this
  as "the document past this point is unparseable; do not execute
  anything after the last successful item."

## 11. Whitespace and Comments

Plurnk is HEREDOC-disciplined and LLM-tolerant: forgiving where
forgiveness is safe, strict where laxity would corrupt content.

- **Between header elements** (`OPsuffix`, `[signal]`, `(path)`,
  `<L>`, the body-delimiter `:`): whitespace (spaces, tabs, newlines)
  is optional and non-significant.
- **Inside header elements** (between the brackets/parens/angles
  themselves — e.g., inside `[…]`, `(…)`, `<…>`, between `OP` and
  `suffix`): whitespace is forbidden. These are strict tokens.
- **Body interior**: whitespace is preserved verbatim. Body content
  begins at the character immediately after the opening `:` and ends
  immediately before the closing `:OPsuffix`. Leading and trailing
  newlines in body content (common for multi-line bodies written by
  the model) are part of the body; runtime consumers may normalize
  them.
- **Close tag** (`:OPsuffix`): the `:` and the `OPsuffix` must be
  character-adjacent — no whitespace permitted between them. Whitespace
  *before* the close `:` (i.e., trailing whitespace in body) is body
  content, preserved verbatim.

Comments: plurnk has no comment syntax. The protocol is wire-shaped,
not source-shaped. To leave a self-documenting breadcrumb, use
`<<EDIT(known:///notes/…):…:EDIT` (model-visible) or
`<<SEND[1xx](…):…:SEND` (orchestrator-visible).

## 12. Public API

The entry points are `PlurnkParser.parse` (a model turn), `PlurnkParser.parseStatements` (a bare statement sequence), `PlurnkParser.parseLog` (a multi-turn log), and `PlurnkParser.parseClient` (the client tier — protocol ops plus the client-only utility ops LOOK and BUFF), alongside the AST type union and a top-level `parsePath` helper. The full surface area:

```typescript
// Parse a model TURN — the `*:PLAN:OPS:SEND[N]` sandwich, enforced entirely by the
// grammar: free text before PLAN, a required PLAN, nothing but whitespace between/after
// ops, and a required terminal SEND. A packet without a PLAN and a terminal SEND is
// invalid. A Plurnk packet IS a turn; there is no permissive fallback.
PlurnkParser.parse(input: string): ParseResult

// Parse a bare sequence of statements — teaching-example collections, single ops,
// documentation snippets. Strict: statements only (whitespace is hidden), no prose, no
// turn shape. Not for model output; use `parse` for that.
PlurnkParser.parseStatements(input: string): ParseResult

// Parse the CLIENT tier — a bare sequence of protocol statements plus the two client-only
// utility ops, LOOK (READ minus the log side effect) and BUFF (pull an editable entry into a
// buffer; the write-back is a later plain EDIT). The topmost subset, one above the model/script
// tiers; never used for model output. The other entry points reject LOOK/BUFF, so a client op
// only parses here. Returns ParseResult<ClientStatement>.
PlurnkParser.parseClient(input: string): ParseResult<ClientStatement>

// Parse a path/URI string into a ParsedPath — the exact decomposition the parser
// applies to every (target) slot. The top-level helper to reach for (no need to
// touch AstBuilder). Primary use: resolving a COPY destination. COPY's body is an
// opaque string — a destination URI for an entry copy, a prompt for a run fork
// (run://) — so the scheme handler interprets it, then calls this for the
// destination case. MOVE destinations arrive pre-parsed (body is always a path);
// COPY's do not, because its body is polymorphic.
parsePath(raw: string): ParsedPath | null

type ParseResult = {
    items: ParseItem[];
    unparsedTail?: { from: Position; reason: string };
};

type ParseItem =
    | { kind: "statement"; statement: PlurnkStatement }
    | { kind: "error"; error: PlurnkParseError }
    | { kind: "text"; text: string; position: Position };

type Position = { line: number; column: number };

type PlurnkOp = "FIND" | "READ" | "EDIT" | "COPY" | "MOVE" | "OPEN" | "FOLD" | "SEND" | "EXEC" | "KILL" | "PLAN";

type PlurnkStatement =
    | FindStatement | ReadStatement | EditStatement
    | CopyStatement | MoveStatement
    | OpenStatement | FoldStatement
    | SendStatement | ExecStatement
    | KillStatement | PlanStatement;

// Client tier only (parseClient). LOOK/BUFF are read-shaped — identical fields to
// ReadStatement, differing only in `op`. Kept out of PlurnkOp/PlurnkStatement so the protocol
// AST stays a closed set; client ops never widen the model-facing type.
type ClientOp = "LOOK" | "BUFF";
type ClientStatement = PlurnkStatement | LookStatement | BuffStatement;

interface StatementBase<S> {
    suffix: string;          // empty string if no suffix
    signal: S | null;        // null = no [signal] slot; type S varies per OP (see below)
    path: ParsedPath | null; // typed parse of (path); null if no slot or empty
    lineMarker: LineMarker | null;
    position: Position;
    // body type varies per OP — declared on each concrete statement (below).
}

interface LineMarker { marks: number[]; } // 1+ ordered components; arity = consumer interpretation

// Path is local (no scheme) or URL (has scheme). The Visitor decides by
// matching the leading [a-z][a-z0-9+.-]*:// pattern; only URLs are passed
// through `new URL()` for component breakdown.
type ParsedPath = LocalPath | UrlPath;

interface LocalPath {
    kind: "local";
    raw: string;             // filesystem path or other non-URL identifier
}

interface UrlPath {
    kind: "url";
    raw: string;
    scheme: string;          // protocol without trailing ':'
    username: string | null;
    password: string | null;
    hostname: string | null; // first authority segment; for custom schemes like
                             // `known:///entries/foo`, hostname = "entries"
    port: number | null;
    pathname: string;        // path component, may be empty
    search: Record<string, string | string[]>;
    fragment: string | null;
}

// Typed body for FIND/READ/OPEN/FOLD — dialect dispatch with compiled regex.
type MatcherBody =
    | { dialect: "xpath"; raw: string }
    | { dialect: "regex"; raw: string; pattern: string; flags: string; regexp: RegExp }
    | { dialect: "jsonpath"; raw: string }
    | { dialect: "semantic"; raw: string }
    | { dialect: "graph"; raw: string }
    | { dialect: "glob"; raw: string };

// Typed body for SEND — best-effort JSON parse alongside raw.
interface SendBody {
    raw: string;
    json: unknown | null;    // parsed value if body is valid JSON, else null
}

// Each variant declares its own body type. Tag-bearing OPs share signal=string[];
// SEND uses number; EXEC uses string.

// Matcher OPs — body is a typed pattern matcher.
interface FindStatement extends StatementBase<string[]> { op: "FIND"; body: MatcherBody | null; }
interface ReadStatement extends StatementBase<string[]> { op: "READ"; body: MatcherBody | null; }
interface OpenStatement extends StatementBase<string[]> { op: "OPEN"; body: MatcherBody | null; }
interface FoldStatement extends StatementBase<string[]> { op: "FOLD"; body: MatcherBody | null; }

// EDIT — body is arbitrary content (markdown, code, prose). Raw.
interface EditStatement extends StatementBase<string[]> { op: "EDIT"; body: string | null; }

// MOVE — body is the destination URI, parsed identically to the path slot.
interface MoveStatement extends StatementBase<string[]> { op: "MOVE"; body: ParsedPath | null; }
// COPY — body is an opaque raw string: a destination URI for entry copies, a
// prompt for run forks. The scheme handler interprets it; the parser does not.
interface CopyStatement extends StatementBase<string[]> { op: "COPY"; body: string | null; }

// SEND — body is raw + best-effort JSON.
interface SendStatement extends StatementBase<number> { op: "SEND"; body: SendBody | null; }

// EXEC — body is a command or code snippet. Raw.
interface ExecStatement extends StatementBase<string> { op: "EXEC"; body: string | null; }

// KILL — signal is a unix signal number; body is an opaque annotation. Raw.
interface KillStatement extends StatementBase<number> { op: "KILL"; body: string | null; }

// PLAN — body is reasoning text, recorded to the log. Raw.
interface PlanStatement extends StatementBase<string[]> { op: "PLAN"; body: string | null; }
```

The `op` field is the discriminator. TypeScript narrows the statement
type per-branch: `switch (s.op) { case "EDIT": /* s is EditStatement */ }`.

**Items are ordered.** The agent consumer iterates in order: execute on
`statement`, halt on `error`, surface or ignore `text` per policy.

**ANTLR types do not leak.** All `antlr4ng` types are internal to this
package; consumers receive only the types listed above.

### CLI

The package also exposes a `plurnk` CLI for local development and tooling:

```
plurnk [file]      Parse plurnk source from a file (or stdin if omitted or '-')
                   and print the parse result as JSON.
plurnk --help      Show usage.
```

Exit codes: `0` for a clean parse (no error items, no `unparsedTail`),
`1` otherwise. `RegExp` values inside `MatcherBody` serialize as their
`/pattern/flags` string form; `PlurnkParseError` instances serialize via
their `toJSON()` method to `{ line, column, source, message }`.

## 13. Error Format

`PlurnkParseError` is a JSON-serializable Error subclass:

```typescript
type ErrorSource = "lexer" | "parser" | "visitor";
type Severity = "error" | "warning";

class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: ErrorSource;
    readonly severity: Severity;   // default "error"; "warning" for advisories (e.g. near-miss ops)
    // .message is "Plurnk <source> <severity> at line <line>:<column> - <message>"
}
```

The three sources distinguish:

- **`"lexer"`** — token-level failures (unrecognized character, malformed integer in `<L>`, etc.).
- **`"parser"`** — structural failures at parse-tree level (missing close tag, wrong token order, etc.).
- **`"visitor"`** — semantic failures during AST construction (SEND signal not an integer, EXEC signal with multiple values, etc.).

`severity` distinguishes a hard error from a non-fatal advisory. The parser is the sole and complete owner of syntax-error messaging (it holds the parse state, lexer mode, and expected-token set that no consumer has), so it produces the final model-ready message plus value-adds: deduped expected-token lists, turn-shape imperatives (begin with `<<PLAN`, end with a terminal `<<SEND`), and `warning`-severity near-miss advisories when the forgiving parser swallows a `<<Word…:Word` heredoc whose keyword is a known op confusion (`<<CLOSE` → did you mean `<<FOLD`). `severity: "warning"` maps to TelemetryEvent `level: "warn"`. Consumers transmit the message to the model unaltered.

Serialization convention for transmission to the model (the agent
runtime constructs this; the parser provides the fields):

```json
{
    "line": 1,
    "column": 12,
    "source": "parser",
    "severity": "error",
    "message": "expected close tag `:OPsuffix`; got end of input"
}
```

**Message style rules** (enforced by `PlurnkErrorStrategy` and the
lexer message translator):

- **Protocol vocabulary only.** Messages refer to plurnk concepts (open
  tag, close tag, signal, path, line marker, body, statement header,
  between statements) — never ANTLR or parser-internal terms (no
  "token recognition error," "extraneous input," "RPAREN," "no viable
  alternative," "<EOF>", etc.).
- **Terse but complete.** One short sentence naming what was wrong.
  No suggestions, no recovery hints, no extra context. The model
  receives `line`/`column` separately and doesn't need duplication.
- **Slot/feature references**, not rule references. "in path" rather
  than "in rule path"; "expected close tag" rather than "expected
  CLOSE_TAG."

Examples of canonical messages:

- `unrecognized character '<<' in path`
- `unrecognized character ':' in signal`
- `unrecognized character 'X' in statement header`
- `expected close tag; got end of input`
- `expected ')'; got ':'`

**Per-statement semantics.** A single statement produces at most one
error (fail-hard within a statement; first error wins, no cascading
within-statement reports). Across statements, the parser recovers and
continues — independent malformations in different statements each
get their own error item in the result.

**Boundary-destroying errors.** When the lexer cannot determine where
a malformed statement ends (e.g., a body that never finds its close
tag), the parser cannot reliably parse content after that point. The
result's `unparsedTail` field marks the position from which parsing
gave up. Consumers must treat anything past that point as undefined.
