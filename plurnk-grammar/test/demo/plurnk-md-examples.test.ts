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

// Examples now live in ```plurnk fenced blocks (plurnkdown house-style), not bare
// `* ` bullets. Extract the fence bodies from the `## Examples` section and join them.
const exampleBlock = (() => {
    const headingMatch = /^## Examples\s*$/m.exec(plurnkMd);
    assert.ok(headingMatch, "plurnk.md is missing its `## Examples` section");
    const startIdx = (headingMatch.index ?? 0) + headingMatch[0].length;
    const rest = plurnkMd.substring(startIdx);
    const nextHeadingMatch = /^## /m.exec(rest);
    const endIdx = nextHeadingMatch ? nextHeadingMatch.index : rest.length;
    const section = rest.substring(0, endIdx);
    const fences = [...section.matchAll(/^```plurnk\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    assert.ok(fences.length > 0, "`## Examples` section has no ```plurnk fenced block");
    return fences.join("\n").trim();
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
    // (36 after #62: the bag's bare SEND[202] moved into the Delegation breath - the
    // two-turn park/wake/conclude trace - which lives outside this block.)
    assert.equal(statements.length, 36, `expected 36 statements, got ${statements.length}`);
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
// `<scope>` samples, the imperative recovery ops, and the spawn/fork lines)
// otherwise carry no coverage — which is exactly how a bogus `get` target and a
// missing `<<` opener slipped past review before. Extract by matched open/close tag
// (suffix-aware, non-greedy, multiline), then parse each in isolation.
const HEREDOC = /<<(FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|EXEC|WORK|FORK|KILL|SEND|PLAN)(\d|[a-z]+)?[\s\S]*?:\1\2(?![A-Za-z0-9])/g;

// Every heredoc example must be a VALID, parseable statement — no schematic exceptions
// (the old `<N>`/`<N,M>` metavariable allowlist let invalid scope examples hide; grammar#435
// made them concrete, per concrete-over-placeholder). A heredoc-shaped example that does not
// parse is a defect, full stop.
test("every heredoc in plurnk.md parses to one clean statement", () => {
    const heredocs = [...plurnkMd.matchAll(HEREDOC)].map((m) => m[0]);
    // Guard against a broken regex silently matching nothing and passing vacuously.
    assert.ok(heredocs.length >= 50, `heredoc extraction found only ${heredocs.length}; regex likely broke`);

    const failures: string[] = [];
    for (const h of heredocs) {
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

// The plurnkdown house-style contract: every ```plurnk fenced block in the document must
// parse clean as a statement sequence (the linter's op-fence rule, enforced here against
// the canonical grammar). Unlike the heredoc test - which parses each op in isolation -
// this parses each block whole, so it also catches bad separators or non-op text leaking
// into a fence. A ```plurnk block that does not parse cannot ship as canon.
const PLURNK_FENCE = /^```plurnk\n([\s\S]*?)^```/gm;
test("every ```plurnk fenced block in plurnk.md parses clean", () => {
    const fences = [...plurnkMd.matchAll(PLURNK_FENCE)].map((m) => m[1]);
    assert.ok(fences.length >= 5, `expected several plurnk fences, found ${fences.length}`);

    const failures: string[] = [];
    fences.forEach((body, i) => {
        const result = PlurnkParser.parseStatements(body);
        const errors = result.items.filter((x) => x.kind === "error");
        if (errors.length > 0 || result.unparsedTail) {
            const detail = errors.map((e) => (e.kind === "error" ? e.error.message : "")).join(" | ")
                || `unparsedTail=${Boolean(result.unparsedTail)}`;
            failures.push(`fence ${i + 1}: ${detail}`);
        }
    });
    assert.equal(failures.length, 0, `plurnk fenced blocks that do not parse:\n${failures.join("\n")}`);
});
