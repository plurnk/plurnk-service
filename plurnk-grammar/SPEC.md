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

- URI resolution: what `known://`, `unknown://`, `file://` actually point at; what bare paths resolve to.
- Tag-matching combination (AND/OR), tag-set semantics.
- Line-marker arithmetic, out-of-range handling, result-set ordering for pagination.
- Status code *meanings*: any digit string is grammatically valid in `[signal]`; whether `[410]` means "Gone" or any code carries privileged semantics on any OP is runtime convention.
- Empty-body semantics (e.g., empty EDIT clears the entry).
- EXEC body execution: runtime selection, sandboxing, permissions.
- Filter composition (how SHOW/HIDE combine path × tag × body filters).
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
| `(path)`    | required for all OPs except SEND |
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
- `OP` — exactly one of: `FIND`, `READ`, `EDIT`, `COPY`, `MOVE`, `SHOW`, `HIDE`, `SEND`, `EXEC`.
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
| COPY   | tags to apply (CSV) | required | destination URI       | entry lines |
| MOVE   | tags to apply (CSV) | required | destination URI       | entry lines |
| SHOW   | tag filter (CSV)  | required | optional pattern matcher | result-set pagination |
| HIDE   | tag filter (CSV)  | required | optional pattern matcher | result-set pagination |
| SEND   | HTTP status code (single integer) | optional | message payload (JSON by convention for structured responses) | not applicable |
| EXEC   | runtime tag (single string; `sh` default, `node`, `python`, …) | required | command or code snippet | not applicable |

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

SHOW and HIDE filters are AND-combined: an entry is selected when its
path matches `(path)`, its tags satisfy `[signal]` (if present), and its
content matches `body` (if present).

### Per-OP Output (what each OP produces)

| OP   | Produces |
|------|----------|
| FIND | list of matching paths |
| READ | content of matched entries (or matched substrings if `body` is a pattern) |
| EDIT | status; resulting entry content on success |
| COPY | status; destination path on success |
| MOVE | status; destination path on success |
| SHOW | status; list of paths moved into Active Context |
| HIDE | status; list of paths moved into Extended Context |
| SEND | status; recipient ack if applicable |
| EXEC | exit code, stdout, stderr |

Output is delivered to the model in the next turn. The shape of "status"
is a SEND-style status code (see §9) so that errors are uniform across
all OPs.

## 5. Path Grammar

Paths are URI-shaped, drawn from RFC 3986 in spirit but not strictly.
Two RFC concessions justify the relaxation:

1. RFC 3986 lists `)` as a sub-delim — a valid path character. Plurnk
   reserves `)` to close the path slot. Strict compliance would
   require an escape mechanism; plurnk does not provide one.
2. Bulk Pattern Matching extends path segments with glob
   metacharacters (`*`, `**`, `?`, `[…]`) that fall outside the RFC
   character set.

Lexer-enforced shape:

- Optional scheme: `[a-z][a-z0-9+.-]*` followed by `://`.
- Path content: any character except `)` and newline.
- Glob metacharacters in path segments are permitted.

Runtime-enforced semantics:

- Bare paths (no scheme) resolve as `file://` at runtime.
- Conventional schemes include `known://`, `unknown://`, `log://`,
  `file://`, `http://`, `https://`. Any scheme matching the lexer
  shape is grammatically valid; resolution is a runtime concern.
- Percent-encoding, authority structure, port range, and other RFC
  3986 finer points are validated by the runtime URI resolver, not
  the parser.

## 6. Bulk Pattern Matching

For FIND, READ, SHOW, and HIDE, `body` is an optional pattern matcher.
The lexer captures the body opaquely (between the `:body:` fences) —
dialect dispatch is not a lexer concern. Dialect is determined by the
body's leading characters, and validated by the Visitor using native
JS facilities (`new RegExp()` etc.) where applicable:

| Leading prefix | Dialect   | Canonical form            | Validation         |
|----------------|-----------|---------------------------|--------------------|
| `//`           | xpath     | `//…`                     | runtime (xpath lib) |
| `/`            | regex     | `/pattern/flags` (trailing `/` required, flags `[a-z]*`) | `new RegExp()` in Visitor |
| `$`            | jsonpath  | `$…`                      | runtime (jsonpath lib) |
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
- Glob is the catch-all and includes the literal-substring case when
  no metacharacters are present.

**Implemented validation in the Visitor (Node-native):**

- **Path**: `new URL(raw)` is attempted first (absolute URLs); on
  failure, `new URL(raw, "file:///")` is attempted (relative paths
  resolve under `file://`). If both fail, a `PlurnkParseError` with
  source `"visitor"` is emitted. WHATWG URL is permissive — spaces
  auto-encode, custom schemes pass through, glob metacharacters in
  segments are accepted. Validation catches genuine URL-protocol
  violations (malformed authority, unterminated IPv6 brackets, invalid
  port, etc.).
- **Regex body** (matcher-body OPs only, leading `/` and not `//`):
  the Visitor extracts `pattern` and `flags` (respecting `\/` escapes)
  and calls `new RegExp(pattern, flags)`. On failure (missing closing
  `/`, unterminated character class, invalid flag, etc.), a
  `PlurnkParseError` with source `"visitor"` is emitted.

**Deferred validation (no Node-native parser available):**

- **XPath** bodies — pass through as raw strings. Validation belongs
  to the runtime where xpath is actually executed against XML/HTML
  content.
- **JsonPath** bodies — same as xpath; pass through as raw.
- **Glob** bodies — pass through as raw; runtime applies whatever glob
  matcher is appropriate.

These can be promoted to Visitor-level validation later by adopting a
lightweight npm dependency (e.g., `xpath`, `jsonpath-plus`) — out of
scope for the grammar package's minimal surface.

**Why not ANTLR sub-grammars for any of these?** Node's `new URL()` and
`new RegExp()` are authoritative, well-tested, and zero-cost to invoke.
ANTLR sub-grammars for URI/regex would add hundreds of lines of
generated parser code with no validation benefit over the native
facilities. For xpath/jsonpath, the same principle applies — when
validation is needed, an npm library is cleaner than re-implementing
a sub-grammar.

## 7. Line Markers

A line marker selects a position or range from the sequence an OP
operates on or produces. The sequence type is OP-specific (see §4
per-OP table): entry lines for EDIT/COPY/MOVE, matched content lines
for READ, positions in the matched-paths list for FIND/SHOW/HIDE.

**Token shape:** `<` `-?[0-9]+` (`-` `-?[0-9]+`)? `>`.

| Form     | Meaning                              |
|----------|--------------------------------------|
| `<N>`    | single position N                    |
| `<N-M>`  | inclusive range N..M                 |
| `<0>`    | prepend anchor (before position 1)   |
| `<-1>`   | append anchor (after last position)  |

Examples involving negative integers:

- `<-1-5>` — range from -1 to 5
- `<0--5>` — range from 0 to -5
- `<-3--1>` — range from -3 to -1

**Parsing rule:** greedy. The first signed integer consumes leading
`-` and digits maximally; the optional `-` range separator follows; the
optional second signed integer consumes its own optional `-` and
digits. So `<-1-5>` parses as first=`-1`, separator=`-`, second=`5`.
This falls out of standard ANTLR longest-match.

**Runtime concerns** (not enforced by the parser):

- `N ≥ 1`: 1-indexed position.
- Validity of any specific value (out-of-range, inverted range where
  `N > M`, sentinel meanings beyond the canonical `0`/`-1`) is decided
  per-OP at runtime.

**Result-set ordering** (FIND, SHOW, HIDE): the runtime must produce a
deterministic order so that `<N-M>` pagination is reproducible.
Lexicographic ascending order over the matched path strings is the
canonical ordering. Runtime guarantee, not a parser concern.

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

Example — nested EDIT inside an outer EDITa:

```
<<EDITa(known://demo):
The following is a quoted plurnk operation, preserved verbatim:
<<EDIT(known://inner):hello world:EDIT
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
`<<EDIT(known://notes/…):…:EDIT` (model-visible) or
`<<SEND[1xx](…):…:SEND` (orchestrator-visible).

## 12. Public API

This package exports a single entry point `parse(input: string): ParseResult` and the AST type union. The full surface area:

```typescript
parse(input: string): ParseResult

type ParseResult = {
    items: ParseItem[];
    unparsedTail?: { from: Position; reason: string };
};

type ParseItem =
    | { kind: "statement"; statement: PlurnkStatement }
    | { kind: "error"; error: PlurnkParseError }
    | { kind: "text"; text: string; position: Position };

type Position = { line: number; column: number };

type PlurnkOp = "FIND" | "READ" | "EDIT" | "COPY" | "MOVE" | "SHOW" | "HIDE" | "SEND" | "EXEC";

type PlurnkStatement =
    | FindStatement | ReadStatement | EditStatement
    | CopyStatement | MoveStatement
    | ShowStatement | HideStatement
    | SendStatement | ExecStatement;

interface StatementBase<S> {
    suffix: string;          // empty string if no suffix
    signal: S | null;        // null = no [signal] slot; type S varies per OP (see below)
    path: string | null;     // raw path string; null if no (path) slot
    lineMarker: LineMarker | null;
    body: string | null;     // raw body string; null if no body
    position: Position;
}

interface LineMarker { first: number; last: number | null; }

// Tag-bearing OPs: signal is a CSV array of tag strings (filter or apply, per OP).
interface FindStatement extends StatementBase<string[]> { op: "FIND"; }
interface ReadStatement extends StatementBase<string[]> { op: "READ"; }
interface EditStatement extends StatementBase<string[]> { op: "EDIT"; }
interface CopyStatement extends StatementBase<string[]> { op: "COPY"; }
interface MoveStatement extends StatementBase<string[]> { op: "MOVE"; }
interface ShowStatement extends StatementBase<string[]> { op: "SHOW"; }
interface HideStatement extends StatementBase<string[]> { op: "HIDE"; }

// SEND: signal is a single integer (HTTP status code).
interface SendStatement extends StatementBase<number> { op: "SEND"; }

// EXEC: signal is a single string (runtime tag).
interface ExecStatement extends StatementBase<string> { op: "EXEC"; }
```

The `op` field is the discriminator. TypeScript narrows the statement
type per-branch: `switch (s.op) { case "EDIT": /* s is EditStatement */ }`.

**Items are ordered.** The agent consumer iterates in order: execute on
`statement`, halt on `error`, surface or ignore `text` per policy.

**ANTLR types do not leak.** All `antlr4ng` types are internal to this
package; consumers receive only the types listed above.

## 13. Error Format

`PlurnkParseError` is a JSON-serializable Error subclass:

```typescript
type ErrorSource = "lexer" | "parser" | "visitor";

class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: ErrorSource;
    // .message is "Plurnk <source> error at <line>:<column> — <message>"
}
```

The three sources distinguish:

- **`"lexer"`** — token-level failures (unrecognized character, malformed integer in `<L>`, etc.).
- **`"parser"`** — structural failures at parse-tree level (missing close tag, wrong token order, etc.).
- **`"visitor"`** — semantic failures during AST construction (SEND signal not an integer, EXEC signal with multiple values, etc.).

Serialization convention for transmission to the model (the agent
runtime constructs this; the parser provides the fields):

```json
{
    "line": 1,
    "column": 12,
    "source": "parser",
    "message": "missing CLOSE_TAG at '<EOF>'"
}
```

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
