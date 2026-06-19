#!/usr/bin/env node
// `gbnf` — validate an input against a GBNF grammar, no model involved. Prints a JSON
// verdict (accept / incomplete / reject + position); exit 0 = accepted, 1 = not.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateGbnf, type Verdict } from "../src/index.ts";

export default class Cli {
    static #usage = `usage: gbnf <grammar.gbnf> [input-file]

Validate an input string against a GBNF grammar. Input is read from the file
argument, or from stdin when it is omitted. Prints a JSON verdict to stdout and
exits 0 when the input is accepted, 1 when it is rejected or incomplete.

options:
  -r, --root <name>   start rule (default: root)
  -h, --help          show this help`;

    static #die(code: number, message: string): never {
        process.stderr.write(`${message}\n`);
        process.exit(code);
    }

    static #read(source: string | number, what: string): string {
        try {
            return readFileSync(source, "utf8");
        } catch (cause) {
            return Cli.#die(66, `cannot read ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }

    static main(): void {
        const { values, positionals } = parseArgs({
            args: process.argv.slice(2),
            options: {
                root: { type: "string", short: "r", default: "root" },
                help: { type: "boolean", short: "h" },
            },
            allowPositionals: true,
        });

        if (values.help) {
            process.stdout.write(`${Cli.#usage}\n`);
            process.exit(0);
        }

        const [grammarPath, inputPath] = positionals;
        if (!grammarPath) Cli.#die(64, Cli.#usage);

        const grammar = Cli.#read(grammarPath, "grammar");
        const input = Cli.#read(inputPath ?? 0, "input");

        let verdict: Verdict;
        try {
            verdict = validateGbnf(grammar, input, values.root);
        } catch (cause) {
            return Cli.#die(78, `invalid grammar: ${cause instanceof Error ? cause.message : String(cause)}`);
        }

        process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
        process.exit(verdict.status === "accept" ? 0 : 1);
    }
}

Cli.main();
