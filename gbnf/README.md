# gbnf

Validate a string against a GBNF grammar: `accept` / `incomplete` (a valid prefix) / `reject`
(a bad code point — with where, and what was expected). The package is Node-native, has no
runtime dependencies, and is differentially tested against llama.cpp's compiled C validator.
The language and verdict contract lives in [SPEC.md](./SPEC.md) {§gbnf-grammar} {§verdict}.

Requires **Node ≥26**.

## Artifacts

| Surface | Authoritative source | Generated and published form     |
| ------- | -------------------- | -------------------------------- |
| Library | `src/*.ts`           | `dist/src/*.js` and declarations |
| CLI     | `bin/gbnf.ts`        | `dist/bin/gbnf.js`               |

`dist/` is ignored and recreated by `npm run build`; `prepack` performs the same build before
publication. Published consumers receive compiled JavaScript and declarations and do not build
the package themselves.

## CLI

```sh
gbnf <grammar.gbnf> [input-file]      # input from stdin when omitted
echo '<input>' | gbnf grammar.gbnf
gbnf -r <rule> grammar.gbnf           # start rule (default: root)

npx @plurnk/gbnf grammar.gbnf input.txt         # once published

# from this source checkout
npm run build
node dist/bin/gbnf.js grammar.gbnf input.txt
```

Prints a JSON verdict to stdout. Exit codes: `0` accept · `1` reject/incomplete · `64` usage ·
`66` unreadable file · `78` invalid grammar.

## Library

```ts
import { validateGbnf, type Verdict } from "@plurnk/gbnf";

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

## Verification

| Contract                    | Command             |
| --------------------------- | ------------------- |
| Types and source            | `npm run test:lint` |
| Library and CLI integration | `npm run test:intg` |
| Published artifact build    | `npm run build`     |

The optional llama.cpp differential gate requires the pinned oracle sources and a C++ toolchain:

```sh
npm run oracle:fetch
npm run oracle:build
npm run test:e2e
```

After the oracle exists, `npm run test:all` runs lint, coverage, and the differential suite.
