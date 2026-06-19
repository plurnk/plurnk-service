# gbnf

A general, Node-native **GBNF** (GGML BNF) grammar utility. Zero runtime dependencies,
npx-friendly, no build step.

Validate whether a string is accepted by a GBNF grammar, returning the same tri-state
verdict llama.cpp's grammar engine produces — `accept` / `incomplete` (a valid prefix) /
`reject` (a bad code point at a position). The engine is a faithful TypeScript port of
llama.cpp's grammar code and is differentially tested against the real llama.cpp validator.

## CLI

```sh
npx gbnf <grammar.gbnf> [input-file]    # input read from stdin when omitted
echo '<some input>' | npx gbnf grammar.gbnf
```

Prints a JSON verdict to stdout; exits `0` when the input is accepted, `1` when it is
rejected or incomplete. `-r, --root <name>` sets the start rule (default `root`).

## Library

```ts
import { validateGbnf } from "gbnf";

validateGbnf('root ::= "hi"', "hi");   // { status: "accept" }
validateGbnf('root ::= "hi"', "ho");   // { status: "reject", pos: 1, char: "o" }
validateGbnf('root ::= "hi"', "h");    // { status: "incomplete", pos: 1 }
```

Requires Node 25+ (runs TypeScript natively, no compile step).
