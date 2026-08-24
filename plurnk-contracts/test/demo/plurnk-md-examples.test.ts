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
const inlineHeadings = [...proseAndInline.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1])
    .filter((example) => headingExample.test(example));
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

test("complete plurnk.md turn specimens parse cleanly", () => {
    assert.ok(completeTurns.length > 0, "plurnk.md contains no complete turn specimen");
    for (const [index, body] of completeTurns.entries()) {
        const result = PlurnkParser.parse(body);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], `specimen ${index + 1}`);
        assert.equal(result.unparsedTail, undefined, `specimen ${index + 1}`);
    }
});

test("plurnk.md retains broad language coverage without pinning prose", () => {
    assert.ok(
        /^# PLAN([A-Za-z0-9_]+)\n[\s\S]*?^## OP\1(?: |$)/m.test(plurnkMd),
        "the syntax sketch teaches `# PLAN` and same-delimiter `## OP` headings",
    );
    for (const operation of operations) {
        assert.match(plurnkMd, new RegExp(`^\\| ${operation} \\|`, "m"), `operation table is missing ${operation}`);
    }
    assert.ok(completeTurns.every((body) => body.startsWith("# PLAN0\n")));
});
