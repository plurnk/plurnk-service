# gbnf

Validate a string against a GBNF grammar: `accept` / `incomplete` (a valid prefix) / `reject`
(a bad code point — with where, and what was expected). Zero dependencies, Node-native, no
build step. The engine is a faithful TypeScript port of llama.cpp's grammar code, differentially
tested against the compiled C validator.

Requires **Node ≥25** (runs TypeScript directly).

## CLI

```sh
gbnf <grammar.gbnf> [input-file]      # input from stdin when omitted
echo '<input>' | gbnf grammar.gbnf
gbnf -r <rule> grammar.gbnf           # start rule (default: root)

npx gbnf grammar.gbnf input.txt       # once published
npx github:plurnk/gbnf grammar.gbnf input.txt   # straight from the repo
```

Prints a JSON verdict to stdout. Exit codes: `0` accept · `1` reject/incomplete · `64` usage ·
`66` unreadable file · `78` invalid grammar.

## Library

```ts
import { validateGbnf, type Verdict } from "gbnf";

validateGbnf(grammar: string, input: string, root = "root"): Verdict

type Verdict =
  | { status: "accept" }
  | { status: "incomplete"; pos: number }                              // pos = input length
  | { status: "reject"; pos: number; char: string; expected: Expected[] };

type Expected = { rule: string; accepts: string };   // e.g. { rule: "value", accepts: "'a'-'z'" }
```

```ts
validateGbnf('root ::= "[" [a-z]+ "]"', "[ab1]");
// { status: "reject", pos: 3, char: "1",
//   expected: [ { rule: "root", accepts: "']'" }, { rule: "root_1", accepts: "'a'-'z'" } ] }
```

`pos` is a code-point index. `expected` is empty when end-of-input was the only valid
continuation. Throws on a malformed grammar (syntax error, undefined rule, or left recursion).
