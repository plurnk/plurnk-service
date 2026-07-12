# gbnf — Specification

The contract of the `gbnf` tool: what `validateGbnf` and the `gbnf` CLI guarantee. Each
promise below is tagged with a **squiggle anchor** rendered as a markdown link, e.g.
`[§verdict_accept](#verdict)`. Every anchor has at least one test named `[§verdict_accept]`,
and every such test anchor exists here — a script enforces the bijection both ways
(`scriptify/spec-coverage.ts`, asserted by `test/intg/spec-coverage.test.ts`). See AGENTS.md
§5/§9.

`gbnf` answers one question: **is this input a sentence in this GBNF grammar?** The engine is
a faithful TypeScript port of llama.cpp's grammar engine and is differentially tested against
the compiled C oracle.

---

## Verdict

`validateGbnf(grammar, input, root = "root")` returns exactly one tri-state verdict, modelling
how the pushdown grammar stacks behave when fed the input's Unicode code points:

- Returns `{ status: "accept" }` exactly when the entire input drives some stack to closure —
  i.e. the input is a complete sentence in the grammar. [§verdict_accept](#verdict)
- Returns `{ status: "reject", pos, char }` at the first code point that cannot extend any
  surviving stack; `char` is that code point and `pos` is its index. [§verdict_reject](#verdict)
- Returns `{ status: "incomplete", pos }` when the input is a valid *prefix* but the stacks
  cannot close at end-of-input; `pos` equals the input's code-point length. A truncated
  statement, or a heredoc whose close tag never arrives, is incomplete, not rejected.
  [§verdict_incomplete](#verdict)
- All positions are **code-point indices**, not byte offsets; multibyte input is counted one
  code point at a time. [§position_codepoint](#verdict)
- A `reject` verdict carries an `expected` set: for each live parse stack at the failure
  point, the rendered char-class it would have accepted (`'a'`, `'a'-'z'`, `one of …`,
  `none of …`, `.`) and the rule it belongs to. An empty set means end-of-input was expected.
  This is diagnostic enrichment unique to the TS engine, outside the oracle differential.
  [§diagnose_expected](#verdict)

## Grammar

The parser accepts GBNF as llama.cpp defines it (it parses the grammar's raw UTF-8 bytes):

- Double-quoted `"literals"` match their characters exactly, honouring the escapes
  `\n \r \t \xNN \uNNNN \UNNNNNNNN \\ \" \[ \]`. [§grammar_literals](#grammar)
- Bracketed character classes match a listed set: `[abc]`, inclusive ranges `[a-z]`, negation
  `[^...]`, and `.` for any character. [§grammar_charclass](#grammar)
- Postfix repetition operators apply to the preceding item: `*`, `+`, `?`, `{m}`, `{m,}`,
  `{m,n}`. [§grammar_repetition](#grammar)
- Parenthesised `( ... )` groups nest, and `|` separates alternates. [§grammar_grouping](#grammar)
- Lowercase identifiers are rule references; rules may recurse through references (non-left).
  [§grammar_ruleref](#grammar)
- `#` line comments and surrounding whitespace are skipped. [§grammar_comments](#grammar)
- Validation starts at the `root` rule by default; the start rule is overridable. A grammar
  lacking the requested start symbol is an error. [§grammar_root](#grammar)
- A malformed grammar — a syntax error, an undefined rule reference, or left recursion — is
  surfaced as a thrown error, never papered over with a fallback verdict. [§grammar_invalid](#grammar)

## Fidelity

- For every grammar and input, `validateGbnf`'s verdict — status **and** position — equals the
  compiled llama.cpp oracle's, verified by a curated corpus and a seeded fuzz differential.
  [§oracle_fidelity](#fidelity)

## CLI

`gbnf <grammar.gbnf> [input-file]`:

- Prints the verdict as pretty-printed (2-space) JSON to stdout. [§cli_json](#cli)
- Exits `0` when the input is accepted and `1` when it is rejected or incomplete. [§cli_exit](#cli)
- Reads the input from the file argument, or from stdin when it is omitted. [§cli_stdin](#cli)
- `-r, --root <name>` selects the start rule. [§cli_root](#cli)
- A missing grammar argument is a usage error: exit `64`, usage text on stderr. [§cli_usage](#cli)
