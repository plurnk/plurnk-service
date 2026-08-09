/** Every concrete example in the model-facing reference must parse cleanly. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plurnkMd = readFileSync(join(repoRoot, "plurnk.md"), "utf8");
const PLURNK_FENCE = /^```plurnk\n([\s\S]*?)^```/gm;
const OPENER = /^<<(?:PLAN|FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|EXEC|WORK|FORK|KILL|SEND)/;
const fences = [...plurnkMd.matchAll(PLURNK_FENCE)].map((match) => match[1].trim());
const withoutFences = plurnkMd.replace(PLURNK_FENCE, "");
const inline = [...withoutFences.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1])
    .filter((example) => OPENER.test(example));

test("every inline plurnk.md example parses to one clean statement", () => {
    assert.ok(inline.length > 0, "plurnk.md contains no concrete inline examples");
    const failures: string[] = [];
    for (const example of inline) {
        const result = PlurnkParser.parseStatements(example);
        const statements = result.items.filter((i) => i.kind === "statement");
        const errors = result.items.filter((i) => i.kind === "error");
        if (statements.length !== 1 || errors.length > 0 || result.unparsedTail) {
            const detail = errors.map((e) => (e.kind === "error" ? e.error.message : "")).join(" | ")
                || `${statements.length} statements, unparsedTail=${Boolean(result.unparsedTail)}`;
            failures.push(`${JSON.stringify(example)} -> ${detail}`);
        }
    }
    assert.equal(failures.length, 0, `inline plurnk.md examples that do not cleanly parse:\n${failures.join("\n")}`);
});

test("every ```plurnk fenced turn in plurnk.md parses clean", () => {
    assert.ok(fences.length > 0, "plurnk.md contains no ```plurnk fenced turns");

    const failures: string[] = [];
    fences.forEach((body, i) => {
        const result = PlurnkParser.parse(body);
        const errors = result.items.filter((x) => x.kind === "error");
        if (errors.length > 0 || result.unparsedTail) {
            const detail = errors.map((e) => (e.kind === "error" ? e.error.message : "")).join(" | ")
                || `unparsedTail=${Boolean(result.unparsedTail)}`;
            failures.push(`fence ${i + 1}: ${detail}`);
        }
    });
    assert.equal(failures.length, 0, `plurnk fenced blocks that do not parse:\n${failures.join("\n")}`);
});

test("{§turn-shape} model reference teaches the complete turn frame", () => {
    assert.ok(plurnkMd.includes("A turn concatenates complete OPs;"));
    assert.match(plurnkMd, /^\| PLAN \| open turn with intended goals /m);
    assert.match(plurnkMd, /^\| SEND \| close turn with submit code /m);
});

test("{§text-scope-semantics}{§whitespace-contract} model reference teaches whole-line deletion", () => {
    assert.ok(plurnkMd.includes("`<<EDIT(notes.md)<2>::EDIT` deletes line 2"));
    assert.ok(plurnkMd.includes("PLURNK does not decode body escapes: `\\n` is backslash plus `n`."));
});

// Model teaching mirrors the packet prose thresholds without adding a reverse package
// dependency. {§packet-atomic-prose}
test("plurnk.md prose has no run-on sentences", () => {
    let inFence = false;
    const prose: string[] = [];
    for (const line of plurnkMd.split("\n")) {
        if (line.startsWith("```")) { inFence = !inFence; continue; }
        if (inFence || /^\s*\|/.test(line) || /^#{1,6}\s/.test(line) || line.trim() === "") continue;
        prose.push(line.replace(/^\s*[-*]\s+/, ""));
    }
    const runons: string[] = [];
    for (const line of prose) {
        for (const s of line.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean)) {
            if (s.length >= 180 || (s.length >= 120 && s.includes(";"))) runons.push(`[${s.length}c] ${s}`);
        }
    }
    assert.equal(runons.length, 0, `run-on sentences in plurnk.md prose:\n${runons.join("\n")}`);
});
