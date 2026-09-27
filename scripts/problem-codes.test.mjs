import assert from "node:assert/strict";
import test from "node:test";
import { declaredCodes, mintedCodes } from "./problem-codes.mjs";

const declare = (tag) => `${"§"}${tag}`;

test("{§problem-codes-declared}: the three minting shapes name a code; prose and tests do not", () => {
    const source = [
        'return failure("stale-target", 409, "The target moved.");',
        'Problems.create("scheme:file", "path-outside-workspace", 403, "Out.");',
        'const rejection = { code: "file-create-excluded", status: 403 };',
        'log("not-a-code", value); // no status follows',
    ].join("\n");
    assert.deepEqual([...mintedCodes(source)].sort(), ["file-create-excluded", "path-outside-workspace", "stale-target"]);
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
