#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "../src/index.ts";

const USAGE = `Usage:
  plurnk [file]      Parse plurnk source from a file (or stdin if omitted or '-')
                     and print the result as JSON.
  plurnk --help      Show this message.

Exit codes:
  0   parse succeeded with no errors and no unparsed tail
  1   parse produced one or more errors, or left an unparsed tail`;

const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
        help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
});

if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
}

const target = positionals[0];
const input = !target || target === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(target, "utf8");

const result = parse(input);

const serialized = JSON.stringify(
    result,
    (_key, value) => (value instanceof RegExp ? value.toString() : value),
    2,
);
process.stdout.write(`${serialized}\n`);

const hasIssues = result.items.some((i) => i.kind === "error") || result.unparsedTail !== undefined;
process.exit(hasIssues ? 1 : 0);
