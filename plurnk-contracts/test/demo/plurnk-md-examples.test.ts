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
// 4-space-indented code blocks carry the plurnk specimens; interior empty lines
// stay part of the block (they separate sections inside the specimen itself).
const specimens: string[] = [];
const proseChunks: string[] = [];
const lines = plurnkMd.split("\n");
for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith("    ")) {
        proseChunks.push(lines[i]);
        i++;
        continue;
    }
    const block: string[] = [];
    while (i < lines.length && (lines[i].startsWith("    ") || lines[i] === "")) {
        block.push(lines[i].startsWith("    ") ? lines[i].slice(4) : "");
        i++;
    }
    specimens.push(block.join("\n").trim());
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
        specimens.some((body) => /^# PLAN([A-Za-z0-9_]+)\n[\s\S]*^## OP\1(?: |$)/m.test(body)),
        "syntax specimen teaches `# PLAN` and same-delimiter `## OP` headings",
    );
    for (const operation of operations) {
        assert.match(plurnkMd, new RegExp(`^\\| ${operation} \\|`, "m"), `operation table is missing ${operation}`);
    }
    assert.ok(completeTurns.every((body) => body.startsWith("# PLAN0\n")));
});
