/** Broad structural checks for the model-facing reference, never wording pins. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plurnkMd = readFileSync(join(repoRoot, "plurnk.md"), "utf8");
const operations = ["PLAN", "FIND", "READ", "EDIT", "COPY", "MOVE", "FOLD", "OPEN", "EXEC", "BARE", "WORK", "FORK", "KILL", "SEND"];
// ```plurnk fences carry the turn specimens ({§packet-operation-fences});
// other fences (mermaid) are excluded, and everything outside a fence is prose.
const specimens: string[] = [];
const proseChunks: string[] = [];
{
    const lines = plurnkMd.split("\n");
    let fenceLanguage: string | null = null;
    let block: string[] = [];
    for (const line of lines) {
        const opened: RegExpExecArray | null = fenceLanguage === null ? /^```(\w*)$/.exec(line) : null;
        if (opened !== null) {
            fenceLanguage = opened[1] ?? "";
            block = [];
            continue;
        }
        if (fenceLanguage !== null && line === "```") {
            if (fenceLanguage === "plurnk") specimens.push(block.join("\n").trim());
            fenceLanguage = null;
            continue;
        }
        if (fenceLanguage !== null) {
            block.push(line);
            continue;
        }
        proseChunks.push(line);
    }
}
const proseAndInline = proseChunks.join("\n");
const headingExample = new RegExp(`^#{1,2} (?:${operations.join("|")})[A-Za-z0-9_]*(?: |$)`);
// A bracketed signal containing whitespace is a prose placeholder (`[submit code]`),
// not an example — real signals never carry spaces. Placeholders are skipped, not parsed.
const placeholderSignal = /\[[^\]]*\s[^\]]*\]/;
const inlineHeadings = [...proseAndInline.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1])
    .filter((example) => headingExample.test(example) && !placeholderSignal.test(example));
const completeTurns = specimens.filter((body) => /^## SEND[A-Za-z0-9_]+ \[(?:102|200|202|300|499)\]/m.test(body));

test("inline operation headings in plurnk.md parse as one clean statement", () => {
    assert.ok(inlineHeadings.length > 0, "plurnk.md contains no inline operation headings");
    const failures: string[] = [];
    for (const example of inlineHeadings) {
        const result = PlurnkParser.parseStatements(example);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        if (statements.length !== 1 || errors.length > 0 || result.unparsedTail) {
            failures.push(`${JSON.stringify(example)} -> ${errors.map(({ error }) => error.message).join(" | ")}`);
        }
    }
    assert.deepEqual(failures, []);
});

// The living complete specimen is the turn-0 program every packet carries, parse-guarded
// at its source (TurnOps.renderInternal throws on invalid output). Fenced doc specimens are
// optional under the compressed teaching; any that exist must still parse.
test("any complete plurnk.md turn specimens parse cleanly", () => {
    for (const [index, body] of completeTurns.entries()) {
        const result = PlurnkParser.parse(body);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], `specimen ${index + 1}`);
        assert.equal(result.unparsedTail, undefined, `specimen ${index + 1}`);
    }
});

// Operator ruling 2026-08-29 (#430): taught nowhere, parsed everywhere — BARE stays in the grammar and engine.
const UNTAUGHT_OPERATIONS = new Set(["BARE"]);

test("plurnk.md retains broad language coverage without pinning prose", () => {
    assert.ok(
        /^# PLAN([A-Za-z0-9_]+)(?: .*)?\n[\s\S]*?^## OP\1(?: |$)/m.test(plurnkMd),
        "the syntax sketch teaches `# PLAN` and same-delimiter `## OP` headings",
    );
    // Every operation is taught as a heading in the per-OP signature sketch (`# PLAN0`, `## FIND0 …`),
    // except the ops the operator has withdrawn from the teaching while their plumbing stays (#430).
    for (const operation of operations) {
        if (UNTAUGHT_OPERATIONS.has(operation)) {
            assert.doesNotMatch(plurnkMd, new RegExp(`\\b${operation}\\b`), `${operation} is withdrawn from the teaching`);
            continue;
        }
        assert.match(plurnkMd, new RegExp(`^#{1,2} ${operation}0\\b`, "m"), `operation signature is missing ${operation}`);
    }
    // The withdrawn ops keep their plumbing: the grammar still accepts them (#430).
    for (const operation of UNTAUGHT_OPERATIONS) {
        const parsed = PlurnkParser.parse(`# PLAN0\n[]\n## ${operation}0 [+probe]\nprompt\n\n## SEND0 [102]\nnext`);
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), [], `${operation} still parses`);
        assert.ok(parsed.items.some((item) => item.kind === "statement" && item.statement.op === operation), `${operation} still dispatches`);
    }
    assert.ok(completeTurns.every((body) => /^# PLAN0(?: |\n)/.test(body)), "every turn specimen opens with the `# PLAN0` heading");
});
