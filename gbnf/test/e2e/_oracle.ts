// Wrapper around the compiled C oracle (build/llama-gbnf). Turns a (grammar, input)
// pair into a structured Verdict. The oracle is the differential reference the native
// TS engine will be measured against (AGENTS.md §9, Charter §8/§9).
//
// The verdict is tri-state, mirroring how llama.cpp's grammar stacks actually behave:
//   accept     — the whole input is a complete sentence in the grammar
//   incomplete — a valid prefix, but EOF arrived before a stack could close
//   reject     — a character at some position cannot extend any stack
// "incomplete" is not "reject": a truncated statement, or a heredoc whose close tag
// never arrives, is a legal prefix the grammar would still extend.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ORACLE = join(here, "..", "..", "build", "llama-gbnf");

export type Verdict =
    | { status: "accept" }
    | { status: "incomplete"; pos: number }
    | { status: "reject"; pos: number; char: string };

const ANSI = /\x1b\[[0-9;]*m/g;

const parse = (out: string): Verdict => {
    if (out.includes("Input string is valid according to the grammar.")) return { status: "accept" };
    const eof = out.match(/Unexpected end of input at position (\d+)/);
    if (eof) return { status: "incomplete", pos: Number(eof[1]) };
    const bad = out.match(/Unexpected character '(.*?)' at position (\d+)/s);
    if (bad) return { status: "reject", pos: Number(bad[2]), char: bad[1] };
    throw new Error(`unparseable oracle output:\n${out}`);
};

export const runOracle = (grammarPath: string, input: string): Verdict => {
    if (!existsSync(ORACLE))
        throw new Error(`oracle missing at ${ORACLE} — run \`npm run build:llama\` first`);
    const dir = mkdtempSync(join(tmpdir(), "gbnf-e2e-"));
    try {
        const inputPath = join(dir, "input");
        writeFileSync(inputPath, input);
        const out = execFileSync(ORACLE, [grammarPath, inputPath], { encoding: "utf8", timeout: 20_000 });
        return parse(out.replace(ANSI, ""));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
