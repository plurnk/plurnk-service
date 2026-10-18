import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { declaredCodes, mintedCodes, undeclaredCodes } from "./problem-codes.mjs";

const declare = (tag) => `§${tag}`;

test("{§problem-codes-declared}: the three minting shapes name a code; prose and tests do not", () => {
    const source = [
        'return failure("stale-target", 409, "The target moved.");',
        'Problems.create("scheme:file", "path-outside-workspace", 403, "Out.");',
        'const rejection = { code: "file-create-excluded", status: 403 };',
        'log("not-a-code", value); // no status follows',
    ].join("\n");
    assert.deepEqual([...mintedCodes(source)].sort(), ["file-create-excluded", "path-outside-workspace", "stale-target"]);
});

test("{§problem-codes-declared}: shared result constructors mint their code regardless of the owner expression", () => {
    const source = [
        'Results.failure("engine:storage", "write-failed", 500, "Failed.");',
        'Results.failure(owner, "audit-unrecordable", 500, "Failed.");',
        'Results.problem(ownerOf("file", "write"), "write-refused", 403, "Refused.");',
        '_Results.failure(OWNER, "stale-source", 409, "Changed.");',
        'Problems.create(OWNER, "upstream-closed", 502, "Closed.");',
        '// Results.failure(OWNER, "comment-only", 400, "Comment.");',
        'const example = \'Results.failure(OWNER, "string-only", 400)\';',
    ].join("\n");
    assert.deepEqual([...mintedCodes(source)].sort(), [
        "audit-unrecordable", "stale-source", "upstream-closed", "write-failed", "write-refused",
    ]);
});

test("{§problem-codes-declared}: repository inspection refuses a shared result code until its own package declares it", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-problem-codes-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const owner = path.join(root, "plurnk-fixture");
    await mkdir(path.join(owner, "src"), { recursive: true });
    await writeFile(path.join(owner, "src", "Example.ts"),
        'Results.failure(owner, "failure-unrecorded", 500, "The failure was not recorded.");');
    const other = path.join(root, "plurnk-other");
    await mkdir(other);
    const declaration = `${declare("problems-fixture")} The \`failure-unrecorded\` result is 500.\n`;
    await writeFile(path.join(other, "SPEC.md"), declaration);
    assert.deepEqual(await undeclaredCodes(root), [{
        package: "plurnk-fixture",
        code: "failure-unrecorded",
        files: ["plurnk-fixture/src/Example.ts"],
    }]);
    await writeFile(path.join(owner, "SPEC.md"), declaration);
    assert.deepEqual(await undeclaredCodes(root), []);
});

test("{§problem-codes-declared}: a code counts as declared only inside a tagged block, a table after its declaring paragraph included", () => {
    const spec = [
        "# Package",
        "",
        `${declare("problems-file")} **File Problems.** Every code, its status and contract:`,
        "",
        "| code | status | contract |",
        "|---|---:|---|",
        "| `path-outside-workspace` | 403 | A symlink resolves outside the namespace. |",
        "",
        "Prose that merely mentions `stale-target` in an untagged paragraph.",
        "",
        "| an untagged table | `file-create-excluded` |",
        "|---|---|",
        "",
        "```",
        `${declare("inert")} a fence is inert, and so is \`fenced-code\``,
        "```",
        "",
        `- ${declare("edit-collision")} **409 \`edit-collision\`** is neutral.`,
    ].join("\n");
    assert.deepEqual([...declaredCodes(spec)].sort(), ["edit-collision", "path-outside-workspace"]);
});

test("{§problem-codes-declared}: a wider outer fence keeps its inner fences inert", () => {
    const spec = [
        "````md",
        "```",
        `${declare("inside")} \`inner-code\``,
        "```",
        "````",
        "",
        `${declare("real")} the real declaration names \`outer-code\`.`,
    ].join("\n");
    assert.deepEqual([...declaredCodes(spec)], ["outer-code"]);
});
