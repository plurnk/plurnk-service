# Plurnk Grammar Specification

## 1. Overview

Plurnk extends HEREDOC formatting into a state-machine grammar for LLM
agents. Every plurnk statement is a single self-contained operation: a
canonical open tag, an optional payload, and a matching close tag.
Statements are flat — there is no composition or substitution. Errors
surface per-statement via SEND status codes aligned with HTTP semantics.

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

**Concretely in domain — parser-managed:**

- Statement structure: open tag, slots, body, close tag.
- Lexical tokens: `<<`, OP keywords, `[…]`, `(…)`, `<N>`, body, close tag.
- Slot *shape* constraints: URI shape (scheme grammar + path character class), line-marker integer form, suffix character class, CSV form of `[signal]`.
- HEREDOC discipline: open/close tag character match, body opacity, nesting via suffix.
- Whitespace rules (§11).
- Hard constraints: `<LineFinal>` requires `<LineFirst>`; close tag matches open.
- Body-mode dispatch (matcher-body vs. content-body) and matcher dialect tagging by leading character. The lexer tags by dialect and enforces the *syntactic frame* (e.g., regex must close with `/` before flags); the inner content is opaque.

**Concretely out of domain — runtime:**

- URI resolution: what `known://`, `unknown://`, `file://` actually point at; what bare paths resolve to; percent-encoding correctness; authority and port semantics.
- Inner-dialect parsing: whether a regex compiles, whether an xpath is well-formed, whether a glob has a valid bracket set.
- Tag-matching combination (AND/OR), tag-set semantics.
- Line-marker arithmetic, out-of-range handling, result-set ordering for pagination.
- Status code *meanings*: any digit string is grammatically valid in `[signal]`; whether `[410]` means "Gone" or any code carries privileged semantics on any OP is runtime convention.
- Empty-body semantics (e.g., empty EDIT clears the entry).
- EXEC body execution: runtime selection, sandboxing, permissions.
- Filter composition (how SHOW/HIDE combine path × tag × body filters).
- Output shape returned to the model. The §4 Per-OP Output table documents convention, not grammar rules.

URI and matcher-body blocks are parser-managed up to their syntactic
shape (§5, §6). Their inner contents are opaque to the parser and are
the responsibility of the runtime sub-parsers.

## 2. Canonical Statement Form

```
<<OPsuffix [signal]? (path)? <LineFirst>? body? <LineFinal>? OPsuffix
```

Optionality:

| Element       | Status        |
|---------------|---------------|
| `<<`          | required      |
| `OP`          | required      |
| `suffix`      | optional      |
| `[signal]`    | optional, OP-dependent contents |
| `(path)`      | required for all OPs except SEND |
| `<LineFirst>` | optional      |
| `body`        | optional, OP-dependent meaning |
| `<LineFinal>` | optional      |
| `OPsuffix`    | required, must character-match the open |

Hard constraints:

- `<LineFinal>` presence requires `<LineFirst>`.
- Close-tag `OP` and `suffix` must literally match the open tag.

All other restrictions are runtime concerns, not grammar concerns.

## 3. Lexical Elements

- `<<` — open delimiter.
- `OP` — exactly one of: `FIND`, `READ`, `EDIT`, `COPY`, `MOVE`, `SHOW`, `HIDE`, `SEND`, `EXEC`.
- `suffix` — `[A-Za-z0-9_]*` immediately concatenated to `OP`, no separator.
- `[` … `]` — signal slot; contents are OP-dependent (see §4).
- `(` … `)` — path slot; contents are a URI (see §5).
- `<N>` — line marker, where `N` is a signed integer.
- `body` — opaque byte stream terminated only by the matching close tag literal `OPsuffix`.
- `OPsuffix` close — must character-match the open OP and suffix.

## 4. Per-OP Semantics

| OP     | `[signal]`        | `(path)` | `body`                  | `<LineN>`     |
|--------|-------------------|----------|-------------------------|---------------|
| FIND   | —                 | required | pattern matcher         | result-set pagination |
| READ   | —                 | required | pattern matcher         | per-entry lines |
| EDIT   | tags (CSV)        | required | content (empty body clears the entry) | entry lines |
| COPY   | —                 | required | destination URI         | entry lines |
| MOVE   | —                 | required | destination URI         | entry lines |
| SHOW   | tag filter (CSV)  | required | optional pattern matcher | result-set pagination |
| HIDE   | tag filter (CSV)  | required | optional pattern matcher | result-set pagination |
| SEND   | `code[,reason]`   | optional | message payload         | not applicable |
| EXEC   | runtime tag (`sh` default, `node`, `python`, …) | required | command or code snippet | not applicable |

All `<LineN>` slots are optional. The slot's *referent* shifts by OP
(per the column above) but the syntax and semantics are uniform:
`<L1><L2>` selects items at positions `L1..L2` inclusive of whatever
sequence the OP operates on or produces.

EDIT line-marker semantics (single source of authority for line-marker
behavior across the grammar):

- No `<LineFirst>` + body present: replace entire entry contents with body.
- No `<LineFirst>` + no body: clear entry contents (empty replacement).
- `<LineFirst>` only + body: replace the single line at `LineFirst` with body.
- `<LineFirst>` + `<LineFinal>` + body: replace lines `LineFirst..LineFinal` inclusive.
- `<0>` … `<0>` + body: prepend body before line 1.
- `<-1>` … `<-1>` + body: append body after the last line.

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
Matcher dialect is resolved at lex time by the body's leading
characters:

| Leading        | Dialect   | Form                      |
|----------------|-----------|---------------------------|
| `//`           | xpath     | `//…`                     |
| `/`            | regex     | `/…/flags` (trailing `/` required, flags `[a-z]*`) |
| `$`            | jsonpath  | `$…`                      |
| otherwise      | glob      | `…` (literal substring if no metacharacters) |

The lexer tags the body token by dialect. The parser receives a typed
token (`XPathBody | RegexBody | JsonPathBody | GlobBody`), not an
opaque string. Inner-dialect validation (whether the regex compiles,
whether the xpath is well-formed) is a runtime concern.

Hard rules:

- Xpath body must begin with exactly `//` (descendant-or-self axis).
  Absolute-root form `/foo` is unreachable; rework as `//foo` or
  embed selection in `(path)`.
- Regex body must be a delimited literal: opens with `/`, ends with `/`
  before the close tag, with optional flag chars `[a-z]*` between the
  closing `/` and the close tag. Literal `/` inside the pattern must
  be escaped `\/`. A regex body that opens with `/` but has no closing
  `/` is a lex error.
- Regex anchors `^` and `$` go inside the slashes: `/^foo$/`.
- Flag semantics (`i` case-insensitive, `m` multiline, `s` dotall,
  etc.) are runtime concerns; the parser accepts any `[a-z]*`.

Glob is the catch-all and includes the literal-substring case when no
metacharacters are present.

## 7. Line Markers

Line markers select a subrange of the sequence an OP operates on or
produces. The sequence type is OP-specific (see §4 per-OP table):
entry lines for EDIT/WIPE/COPY/MOVE, matched content lines for READ,
positions in the matched-paths list for FIND/SHOW/HIDE.

- `<N>` where `N` is a signed decimal integer.
- `N ≥ 1`: 1-indexed position.
- `N = 0`: prepend anchor (position before position 1).
- `N = -1`: append anchor (position after the last position).
- `<LineFirst>` alone: single-position operation at `LineFirst`.
- `<LineFirst>` + `<LineFinal>`: inclusive range; `LineFirst ≤ LineFinal` is a runtime concern.

Result-set ordering (FIND, SHOW, HIDE): the runtime must produce a
deterministic order so that `<L1><L2>` pagination is reproducible.
Lexicographic ascending order over the matched path strings is the
canonical ordering. This is a runtime guarantee, not a parser concern.

## 8. Suffix Discipline

- `suffix` is `[A-Za-z0-9_]*`, concatenated to `OP` with no separator.
- Open and close must character-match: `<<EDITa…EDITa`, `<<READ_outer…READ_outer`.
- Suffix enables nesting. Inside the body of an outer `<<EDITa…EDITa`,
  any `<<EDIT…EDIT` substring is treated as opaque body content because
  the outer close tag is `EDITa`, not `EDIT`. The body of an outer block
  cannot contain its own close-tag literal; choose a suffix that does
  not collide with body content.
- Empty suffix is the default for non-nested statements.

Example — nested EDIT inside an outer EDITa:

```
<<EDITa(known://demo)
The following is a quoted plurnk operation:
<<EDIT(known://inner)hello worldEDIT
EDITa
```

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

## 10. Implementation Notes

- ANTLR4 split follows standard convention: `plurnkLexer.g4` defines
  tokens; `plurnkParser.g4` defines statement structure.
- The body is HEREDOC-discipline: the lexer must enter a body mode after
  the last pre-body element (path, signal, or `<LineFirst>`) is
  consumed, and remain in that mode until the matching close-tag
  literal is found. Because the close tag depends on the runtime value
  of `OP + suffix` from the open, this is most cleanly handled by a
  lexer semantic predicate that captures the open tag and compares
  against it at potential close points.
- Two body modes:
  - **Matcher-body mode** (FIND, READ, SHOW, HIDE) — two-character
    lookahead on the leading characters tags the body as
    `XPathBody`, `RegexBody`, `JsonPathBody`, or `GlobBody`.
  - **Content-body mode** (EDIT, COPY, MOVE, SEND, EXEC) —
    captures opaque content up to the close tag.
- Errors must surface at the statement level with sufficient context to
  emit a `SEND[4xx]` describing the violation. Defensive recovery is
  out of scope; fail hard on contract violation.

## 11. Whitespace and Comments

Plurnk is HEREDOC-disciplined and LLM-tolerant: forgiving where
forgiveness is safe, strict where laxity would corrupt content.

- **Between header elements** (`OPsuffix`, `[signal]`, `(path)`,
  `<LineFirst>`): whitespace (spaces, tabs, newlines) is optional and
  non-significant.
- **Inside header elements** (between the brackets/parens/angles
  themselves — e.g., inside `[…]`, `(…)`, `<…>`, between `OP` and
  `suffix`): whitespace is forbidden. These are strict tokens.
- **Header-to-body transition**: one optional protocol newline is
  consumed between the last header element and the start of body.
  Subsequent characters are body content.
- **Body interior**: whitespace is preserved verbatim. Body content
  begins at the first character after the optional protocol newline
  and ends immediately before the close-tag literal.
- **Body-to-close-tag transition**: one optional protocol newline is
  consumed between the end of body and the close tag.
- **Close tag**: matched as the literal `OPsuffix` wherever it next
  appears after the body. No whitespace permitted inside the close-tag
  token. Suffix discipline (see §8) ensures the literal does not
  collide with body content.

Comments: plurnk has no comment syntax. The protocol is wire-shaped,
not source-shaped. To leave a self-documenting breadcrumb, use
`<<EDIT(known://notes/…)…EDIT` (model-visible) or
`<<SEND[1xx](…)…SEND` (orchestrator-visible).
