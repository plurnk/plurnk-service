# gbnf — Specification

The contract of the `gbnf` tool: what `validateGbnf` and the `gbnf` CLI guarantee.

`gbnf` answers one question: **is this input a sentence in this GBNF grammar?** The engine is
a faithful TypeScript port of llama.cpp's grammar engine and is differentially tested against
the compiled C oracle.

It does not split model channels, identify reasoning, assign token budgets, or
decide when a generation backend applies a grammar. Callers pass the exact
grammar and content to validate; provider transport and reasoning policy remain
outside this package.

---

## §verdict Verdict

`validateGbnf(grammar, input, root = "root")` returns exactly one tri-state verdict, modelling
how the pushdown grammar stacks behave when fed the input's Unicode code points:

- §verdict-accept Returns `{ status: "accept" }` exactly when the entire input drives some stack to closure —
  i.e. the input is a complete sentence in the grammar.
- §verdict-reject Returns `{ status: "reject", pos, char }` at the first code point that cannot extend any
  surviving stack; `char` is that code point and `pos` is its index.
- §verdict-incomplete Returns `{ status: "incomplete", pos }` when the input is a valid *prefix* but the stacks
  cannot close at end-of-input; `pos` equals the input's code-point length. A truncated
  statement, or an enclosure whose close tag never arrives, is incomplete, not rejected.
- §position-codepoint All positions are **code-point indices**, not byte offsets; multibyte input is counted one
  code point at a time.
- §diagnose-expected A `reject` verdict carries an `expected` set: for each live parse stack at the failure
  point, the rendered char-class it would have accepted (`'a'`, `'a'-'z'`, `one of …`,
  `none of …`, `.`) and the rule it belongs to. An empty set means end-of-input was expected.
  This is diagnostic enrichment unique to the TS engine, outside the oracle differential.

## §gbnf-grammar Grammar

The parser accepts GBNF as llama.cpp defines it (it parses the grammar's raw UTF-8 bytes):

- §grammar-literals Double-quoted `"literals"` match their characters exactly, honouring the escapes
  `\n \r \t \xNN \uNNNN \UNNNNNNNN \\ \" \[ \]`.
- §grammar-charclass Bracketed character classes match a listed set: `[abc]`, inclusive ranges `[a-z]`, negation
  `[^...]`, and `.` for any character.
- §grammar-repetition Postfix repetition operators apply to the preceding item: `*`, `+`, `?`, `{m}`, `{m,}`,
  `{m,n}`.
- §grammar-grouping Parenthesised `( ... )` groups nest, and `|` separates alternates.
- §grammar-ruleref Lowercase identifiers are rule references; rules may recurse through references (non-left).
- §grammar-comments `#` line comments and surrounding whitespace are skipped.
- §grammar-root Validation starts at the `root` rule by default; the start rule is overridable. A grammar
  lacking the requested start symbol is an error.
- §grammar-invalid A malformed grammar — a syntax error, an undefined rule reference, or left recursion — is
  surfaced as a thrown error, never papered over with a fallback verdict.

## §fidelity Fidelity

- §oracle-fidelity For every grammar and input, `validateGbnf`'s verdict — status **and** position — equals the
  compiled llama.cpp oracle's, verified by a curated corpus and a seeded fuzz differential.

## §cli CLI

`gbnf <grammar.gbnf> [input-file]`:

- §cli-json Prints the verdict as pretty-printed (2-space) JSON to stdout.
- §cli-exit Exits `0` when the input is accepted and `1` when it is rejected or incomplete.
- §cli-stdin Reads the input from the file argument, or from stdin when it is omitted.
- §cli-root `-r, --root <name>` selects the start rule.
- §cli-usage A missing grammar argument is a usage error: exit `64`, usage text on stderr.
