/**
 * Auto-extracted regression: parses every statement inside plurnk.md's
 * `## Examples` code block. plurnk.md is the model-facing protocol reference;
 * any drift between what we tell the model and what the parser accepts breaks
 * here, loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plurnkMd = readFileSync(join(repoRoot, "plurnk.md"), "utf8");

const exampleBlock = (() => {
    const headingMatch = /^## Examples\s*$/m.exec(plurnkMd);
    assert.ok(headingMatch, "plurnk.md is missing its `## Examples` section");
    const startIdx = (headingMatch.index ?? 0) + headingMatch[0].length;
    const rest = plurnkMd.substring(startIdx);
    const nextHeadingMatch = /^## /m.exec(rest);
    const endIdx = nextHeadingMatch ? nextHeadingMatch.index : rest.length;
    return rest.substring(0, endIdx).trim().replace(/^[ \t]*\* /gm, "");
})();

test("plurnk.md examples block parses with no errors and no unparsed tail", () => {
    const result = PlurnkParser.parseStatements(exampleBlock);
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(
        errors.length,
        0,
        `expected 0 errors, got ${errors.length}: ` +
            errors.map((e) => (e.kind === "error" ? e.error.message : "")).join(" | "),
    );
    assert.equal(result.unparsedTail, undefined, "expected no unparsedTail");
});

test("plurnk.md examples block contains the expected statement count", () => {
    const result = PlurnkParser.parseStatements(exampleBlock);
    const statements = result.items.filter((i) => i.kind === "statement");
    // Snapshot of current example count. Update when plurnk.md gains/loses examples.
    // (34 after the #44 dialect rebalance added a jsonpath FIND crossover, so jsonpath and
    // semantic each appear on both FIND and READ — the op chooses projection, not the dialect.)
    // (35 after adding the KILL × log:// crossover: erase all FOLD ops in the loop.)
    // (36 after adding the recursive project-relative FIND(**/notes.md) example.)
    // (37 after adding the terminal [102]<T> park example, #54.)
    assert.equal(statements.length, 37, `expected 37 statements, got ${statements.length}`);
});

test("plurnk.md examples cover every OP", () => {
    const result = PlurnkParser.parseStatements(exampleBlock);
    const ops = new Set(
        result.items
            .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
            .map((i) => i.statement.op),
    );
    // PLAN is wired but untaught — excluded until it appears in plurnk.md.
    // EXEC examples moved to the service's tool-doc framework (every EXEC example is a
    // tool/executor example); EXEC stays in the Operations table + imperative, not here.
    const required = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "KILL"];
    for (const op of required) {
        assert.ok(ops.has(op as any), `plurnk.md examples should include ${op}`);
    }
});

// CI tripwire: EVERY heredoc anywhere in plurnk.md must parse to one clean statement,
// not just the `## Examples` block. The inline examples (the OP one-liners, the
// `<Line / Result>` samples, the imperative recovery ops, and the spawn/fork lines)
// otherwise carry no coverage — which is exactly how a bogus `get` target and a
// missing `<<` opener slipped past review before. Extract by matched open/close tag
// (suffix-aware, non-greedy, multiline), then parse each in isolation.
const HEREDOC = /<<(FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|EXEC|WORK|FORK|KILL|SEND|PLAN)(\d|[a-z]+)?[\s\S]*?:\1\2(?![A-Za-z0-9])/g;

// Schematic metavariable examples: the `<Line>` slot is a placeholder (N, M), not a
// literal, so they intentionally do not parse. Any addition here is a deliberate act.
const SCHEMATIC = new Set([
    "<<READ(file.md)<N>::READ",
    "<<FIND(src/**)<N,M>::FIND",
]);

test("every heredoc in plurnk.md parses to one clean statement", () => {
    const heredocs = [...plurnkMd.matchAll(HEREDOC)].map((m) => m[0]);
    // Guard against a broken regex silently matching nothing and passing vacuously.
    assert.ok(heredocs.length >= 50, `heredoc extraction found only ${heredocs.length}; regex likely broke`);

    const failures: string[] = [];
    for (const h of heredocs) {
        if (SCHEMATIC.has(h)) continue;
        const result = PlurnkParser.parseStatements(h);
        const statements = result.items.filter((i) => i.kind === "statement");
        const errors = result.items.filter((i) => i.kind === "error");
        if (statements.length !== 1 || errors.length > 0 || result.unparsedTail) {
            const detail = errors.map((e) => (e.kind === "error" ? e.error.message : "")).join(" | ")
                || `${statements.length} statements, unparsedTail=${Boolean(result.unparsedTail)}`;
            failures.push(`${JSON.stringify(h)} -> ${detail}`);
        }
    }
    assert.equal(failures.length, 0, `plurnk.md heredocs that do not cleanly parse:\n${failures.join("\n")}`);
});
