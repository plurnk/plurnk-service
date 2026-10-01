import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, rootWorkspace } from "./_db.ts";
import { makeRawMockResponse } from "./_mock.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";

const turnRows = async (program: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-dir-target-"));
    const db = await openMigrated();
    try {
        await mkdir(join(root, "changelog"));
        await writeFile(join(root, "changelog", "7122.bugfix.rst"), "Fixed the thing.\n");
        await mkdir(join(root, "tests", "forms_tests"), { recursive: true });
        await writeFile(join(root, "tests", "forms_tests", "models.py"), "class A: pass\n");
        await mkdir(join(root, "packages", "chord", "docs"), { recursive: true });
        await writeFile(join(root, "packages", "chord", "README.md"), "# Chord\nPackage documentation.\n");
        await writeFile(join(root, "packages", "chord", "docs", "api.md"), "# Chord API\nAPI documentation.\n");
        await mkdir(join(root, "packages", "chord-extra"), { recursive: true });
        await writeFile(join(root, "packages", "chord-extra", "README.md"), "# Other package\n");
        await mkdir(join(root, "empty"));
        await mkdir(join(root, "excluded"));
        await writeFile(join(root, ".gitignore"), "packages/chord/hidden.md\nexcluded/\n");
        await writeFile(join(root, "packages", "chord", "hidden.md"), "Not a member.\n");
        await writeFile(join(root, "excluded", "hidden.md"), "Not a member.\n");
        const env = hermeticGitEnv();
        const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root, env });
        await git("init", "-q");
        await git("add", "-A");
        await git("-c", "user.email=fixture@plurnk.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "seed");
        const workspaceId = await insertWorkspace(db, `dir-target-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Look around.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [makeRawMockResponse(program)] });
        const turn = await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string; attrs: string }>({ turn_id: turn.turnId });
        return rows.filter((row) => row.op !== "NOTE" && row.op !== "SEND" && !LogEntryProjection.isEmission(row)).map(({ op, rx }) => ({ op, ...JSON.parse(rx) as { status: number; content?: string; problem?: Record<string, unknown> } }));
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// The recorded shapes (#853): `READ (changelog) <1,-1>` (pytest) and `READ (tests/forms_tests/) <0>`
// (django) were answered "exists on disk but is not a member", steering the model to admit a directory.
test("{§file-directory-target}: a directory target says it is a directory and gives the listing that works", async () => {
    const [read, slashed, listing, member, kill, edit] = await turnRows([
        "````READ (changelog) <1,-1>````",
        "````READ (tests/forms_tests/) <0> <!-- list directory structure -->````",
        "````FIND (changelog/)````",
        "````READ (changelog/7122.bugfix.rst)````",
        "````KILL (changelog)````",
        "````EDIT (changelog)\nx\n````",
        "````WAIT````",
    ].join("\n\n")).then((rows) => rows.filter(({ op }) => op !== "SEND"));
    assert.equal(read?.status, 404);
    assert.deepEqual([read?.problem?.type, read?.problem?.detail, read?.problem?.recovery], [
        "https://problems.plurnk.xyz/scheme/file/path-is-directory",
        "'changelog' is a directory, not a file; READ reads one file.",
        "List its files with `FIND (changelog/)`, then READ one by its path.",
    ]);
    assert.equal(slashed?.problem?.detail, "'tests/forms_tests' is a directory, not a file; READ reads one file."); // {§pinned-wording-core}
    assert.equal(slashed?.problem?.recovery, "List its files with `FIND (tests/forms_tests/)`, then READ one by its path."); // {§pinned-wording-core}
    assert.equal(listing?.status, 200, "the named listing form works");
    assert.match(String(listing?.content), /changelog\/7122\.bugfix\.rst/u);
    assert.equal(member?.status, 200, "and the listed path reads");
    assert.deepEqual([kill?.status, kill?.problem?.detail, kill?.problem?.recovery], [
        404,
        "'changelog' is a directory, not a file; KILL removes one file.",
        "List its files with `FIND (changelog/)`, then KILL each by its path.",
    ]);
    assert.deepEqual([edit?.status, edit?.problem?.detail, edit?.problem?.recovery], [
        403,
        "'changelog' is a directory, not a file; EDIT writes one file.",
        "Name a file inside it, as `EDIT (changelog/<file>)`; list its files with `FIND (changelog/)`.",
    ]);
});

const foundPaths = (row: { content?: string }): string[] => {
    const groups = JSON.parse(row.content ?? "null") as { path: string }[][];
    assert.ok(Array.isArray(groups), "FIND returns resource channel groups");
    return groups.map(([first]) => first!.path).toSorted();
};

test("{§file-find-directory}: parsed FIND recognizes a directory with or without its trailing slash", async () => {
    const targets = [
        "packages/chord", "packages/chord/", "/packages/chord", "./packages/chord",
        "packages/other/../chord", "file:///packages/chord",
    ];
    const rows = await turnRows([
        ...targets.map((target) => `\`\`\`FIND (${target})\n\`\`\``),
        "```READ (packages/chord/README.md)\n```",
    ].join("\n\n"));
    assert.equal(rows.length, targets.length + 1);
    for (const [index, target] of targets.entries()) {
        const row = rows[index]!;
        assert.equal(row.status, 200, `FIND (${target}) lists its directory`);
        assert.deepEqual(foundPaths(row), ["packages/chord/README.md", "packages/chord/docs/api.md"],
            "only member descendants appear, excluding hidden files and prefix siblings");
    }
    assert.equal(rows.at(-1)?.status, 200, "the same turn can READ a file in the listed directory");
    assert.equal(rows.at(-1)?.content, "# Chord\nPackage documentation.\n");
});

test("{§file-find-directory}: directory resolution retains FIND matching and pagination", async () => {
    const rows = await turnRows([
        "```FIND (packages/chord) /API/\n```",
        "```FIND (packages/chord/) /API/\n```",
        "```FIND (packages/chord) <1>\n```",
        "```FIND (packages/chord/) <1>\n```",
        "```FIND (packages/chord) /absent/\n```",
        "```FIND (packages/chord/) /absent/\n```",
    ].join("\n\n"));
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.status, 200);
    assert.deepEqual(foundPaths(rows[0]!), ["packages/chord/docs/api.md"]);
    assert.deepEqual(rows[0], rows[1], "matching selects resources identically for either spelling");
    assert.equal(rows[2]?.status, 200);
    assert.deepEqual(foundPaths(rows[2]!), ["packages/chord/README.md"]);
    assert.deepEqual(rows[2], rows[3], "pagination selects resources identically for either spelling");
    assert.equal(rows[4]?.status, 204);
    assert.deepEqual(rows[4], rows[5], "a nonmatching pattern is an empty result, not a missing directory");
});

test("{§file-find-directory}: empty and non-member-only directories are successful empty surveys", async () => {
    const rows = await turnRows(["empty", "empty/", "excluded", "excluded/"].map(
        (target) => `\`\`\`FIND (${target})\n\`\`\``,
    ).join("\n\n"));
    assert.equal(rows.length, 4);
    for (const row of rows) {
        assert.equal(row.status, 200);
        assert.deepEqual(foundPaths(row), []);
    }
});

test("{§file-find-directory}: exact files and missing targets retain their existing semantics", async () => {
    const rows = await turnRows([
        "```FIND (packages/chord/README.md)\n```",
        "```FIND (packages/chor)\n```",
        "```FIND (packages/missing)\n```",
        "```FIND (packages/missing/)\n```",
        "```FIND (packages/chord*)\n```",
        "```FIND (packages/chord/README.md/child)\n```",
    ].join("\n\n"));
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.status, 200);
    assert.deepEqual(foundPaths(rows[0]!), ["packages/chord/README.md"]);
    for (const [index, target] of [[1, "packages/chor"], [2, "packages/missing"], [5, "packages/chord/README.md/child"]] as const) {
        assert.equal(rows[index]?.status, 404);
        assert.equal(rows[index]?.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(rows[index]?.problem?.detail, `No member of this workspace is at '${target}'.`);
    }
    assert.equal(rows[3]?.status, 200, "an explicitly authored folder survey may be empty");
    assert.deepEqual(foundPaths(rows[3]!), []);
    assert.equal(rows[4]?.status, 200, "a glob is not reinterpreted as a literal directory");
    assert.deepEqual(foundPaths(rows[4]!), ["packages/chord-extra/**", "packages/chord/**"]);
});
