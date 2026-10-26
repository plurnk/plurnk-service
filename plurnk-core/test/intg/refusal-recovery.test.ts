import { serverProposals } from "./_approval.ts";
// {§problem-details} — a refusal carries the next step its producer knows (#1005).
// {§membership-read-refusal} {§log-near-miss} {§exec-near-miss} {§unregistered-scheme-recovery} {§fts-word-phrase} {§exec-lifetime}
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { FILE_MISS_RECOVERY } from "../../src/core/plurnk-uri.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { openMigrated, seedEnvelope, rootWorkspace } from "./_db.ts";
import { fixtureExecutors } from "./_mock.ts";
import { executionAddress, quiesceExecs, testExecutors } from "./_execs.ts";

const execFileP = promisify(execFile);
type Problem = { type?: string; detail?: string; recovery?: string; target?: string };
type Row = { status_rx: number; rx: string };

const runtime = async (t: TestContext) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "refusal-recovery-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "generated.log\n");
    await writeFile(join(root, "a.md"), "alpha\n");
    await git(["add", ".gitignore", "a.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    await writeFile(join(root, "generated.log"), "built\n");
    await writeFile(join(root, "loose.md"), "loose\n");
    const db = await openMigrated();
    const ids = await seedEnvelope(db, `refusal-recovery-${crypto.randomUUID()}`);
    await rootWorkspace(db, ids.workspaceId, root);
    const schemes = new SchemeRegistry();
    const executors = await testExecutors();
    schemes.registerRuntimeSchemes(executors);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(executors);
    t.after(async () => {
        await quiesceExecs(schemes);
        db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    let sequence = 0;
    const dispatch = async (source: string): Promise<{ status: number; problem: Problem }> => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const written = await db.log_read_by_coordinate.get<Row>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence });
        assert.ok(written, source);
        return { status: written.status_rx, problem: (JSON.parse(written.rx) as { problem?: Problem }).problem ?? {} };
    };
    return { db, engine, ids, root, dispatch, sequence: () => sequence };
};

test("{§membership-read-refusal} every file miss names its member key and carries the miss recovery", async (t) => {
    const { dispatch } = await runtime(t);
    for (const source of ["````FIND (missing.py)````", "````KILL (missing.py)````", "````EDIT (missing.py) /alpha/\nomega\n````", "````READ (missing.py)````"]) {
        const { status, problem } = await dispatch(source);
        assert.equal(status, 404, source);
        assert.equal(problem.detail, "No member of this workspace is at 'missing.py'.", `${source}: the key, never a file:// URI`);
        assert.equal(problem.recovery, FILE_MISS_RECOVERY, source);
    }
});

test("{§membership-read-refusal} {§file-path-normalization} a key beyond the root is told it is outside the root, by its absolute address, never offered FIND, EDIT or admission", async (t) => {
    const { dispatch, root } = await runtime(t);
    const address = resolve(root, "../outside/delete_tests.log");
    for (const source of ["````READ (../outside/delete_tests.log)````", "````FIND (../outside/delete_tests.log)````", "````KILL (../outside/delete_tests.log)````", `\`\`\`\`READ (${address})\`\`\`\``]) {
        const { status, problem } = await dispatch(source);
        assert.equal(status, 404, source);
        assert.equal(problem.detail, `No member of this workspace is at '${address}'.`, `${source}: the address's membership, nothing about the disk`);
        assert.equal(problem.target, address, `${source}: beyond the root the address is absolute, never a climb`);
        assert.equal(problem.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`, source);
    }
});

test("{§fs-home} {§membership-read-refusal} home, literal and absolute misses retain the resolved identity and membership boundary", async (t) => {
    const { dispatch, root } = await runtime(t);
    const homeKey = relative(root, homedir());
    for (const [spelling, key] of [["~/plurnk-missing.md", `${homeKey}/plurnk-missing.md`], ["~", homeKey], ["~/", homeKey]]) {
        const miss = await dispatch(PlurnkParser.frame(`READ (${spelling})`, null));
        // {§file-path-normalization} The home directory lies beyond this root, so its address is absolute.
        const address = key.startsWith("../") ? resolve(root, key) : key;
        assert.equal(miss.status, 404, spelling);
        assert.equal(miss.problem.detail, `No member of this workspace is at '${address}'.`);
        assert.equal(miss.problem.target, address);
        assert.equal(miss.problem.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`);
    }
    for (const [spelling, key] of [["./~/missing.md", "~/missing.md"], ["./~", "~"], ["~someone/notes.md", "~someone/notes.md"]]) {
        const miss = await dispatch(PlurnkParser.frame(`READ (${spelling})`, null));
        assert.equal(miss.status, 404, spelling);
        assert.equal(miss.problem.detail, `No member of this workspace is at '${key}'.`);
        assert.equal(miss.problem.target, spelling, "the literal member address can be reused");
        assert.equal(miss.problem.recovery, FILE_MISS_RECOVERY);
    }
    // An absolute path beyond the root is spelled back as itself and carries the outside-root recovery.
    const outsideName = `plurnk-outside-${crypto.randomUUID()}.md`;
    const outsideAddress = resolve(root, "..", outsideName);
    const outside = await dispatch(`\`\`\`\`READ (${join(root, "..", outsideName)})\`\`\`\``);
    assert.equal(outside.status, 404);
    assert.equal(outside.problem.detail, `No member of this workspace is at '${outsideAddress}'.`, "the absolute address, never a climb");
    assert.equal(outside.problem.recovery, `'${outsideAddress}' is outside the project root: only a members definition under the operator's namespace scope admits it.`);
    // An absolute path inside the root is its in-root key and keeps the in-root recovery.
    const inside = await dispatch(`\`\`\`\`READ (${join(root, "missing.py")})\`\`\`\``);
    assert.equal(inside.status, 404);
    assert.equal(inside.problem.detail, "No member of this workspace is at 'missing.py'.");
    assert.equal(inside.problem.recovery, FILE_MISS_RECOVERY, "inside the root the listing, creation and admission doors stand");
});

test("{§membership-read-refusal} a non-member an exclusion covers or the repository ignores is not offered an admission no model definition can make", async (t) => {
    const { db, ids, root, dispatch } = await runtime(t);
    const ignored = await dispatch("````READ (generated.log)````");
    assert.equal(ignored.problem.detail, "'generated.log' exists on disk but is not a member of this workspace.");
    assert.equal(ignored.problem.recovery, "Git ignores it (`.gitignore` line 1): a client or operator members definition can include it, a model definition cannot.");
    const untracked = await dispatch("````READ (loose.md)````");
    assert.equal(untracked.problem.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.", "an untracked file is still admitted");
    await writeFile(join(root, "secret.md"), "hidden\n");
    await db.crud_insert_family_workspace_constraint.run({ workspace_id: ids.workspaceId, effect: "exclude", glob: "secret.md", source: "members" });
    const excluded = await dispatch("````READ (secret.md)````");
    assert.equal(excluded.problem.detail, "'secret.md' exists on disk but is not a member of this workspace.", "an excluded file on disk says so");
    assert.doesNotMatch(excluded.problem.recovery ?? "", /plurnk \(members\)/u, "an exclusion no add lifts is not offered one");
    assert.match(excluded.problem.recovery ?? "", /!secret\.md/u, "the refusal names the exclusion");
});

// {§membership-ignore-source} Each place an ignore rule lives, named by its file and line: the repository's `.gitignore`,
// its `.git/info/exclude`, git's default excludes file under the daemon user's configuration home, and a `core.excludesFile`
// that user configures ({§membership-git-hermetic}); a negated pattern re-includes and is no ignore.
test("{§membership-ignore-source} an ignored file's refusal names the rule's file and line, wherever the rule lives", async (t) => {
    const { root, dispatch } = await runtime(t);
    const prior = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    const homes = await mkdtemp(join(tmpdir(), "ignore-homes-"));
    t.after(async () => {
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(homes, { recursive: true, force: true });
    });
    const asHome = async (name: string, files: Record<string, string>): Promise<void> => {
        const home = join(homes, name);
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(home, path, ".."), { recursive: true });
            await writeFile(join(home, path), content);
        }
        process.env.HOME = home;
        process.env.XDG_CONFIG_HOME = join(home, ".config");
    };
    await appendFile(join(root, ".gitignore"), "*.tmp\n!keep.tmp\n");
    const exclude = join(root, ".git", "info", "exclude");
    const excludeLine = (await readFile(exclude, "utf8").catch(() => "")).split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0).length + 1;
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await appendFile(exclude, "info.md\n");
    for (const name of ["default.md", "configured.md", "info.md", "drop.tmp", "keep.tmp"]) await writeFile(join(root, name), "x\n");
    const named = async (path: string): Promise<string | undefined> => (await dispatch(`\`\`\`\`READ (${path})\`\`\`\``)).problem.recovery;

    await asHome("default", { ".config/git/ignore": "default.md\n" });
    for (const [path, file, line] of [["default.md", "~/.config/git/ignore", 1], ["info.md", ".git/info/exclude", excludeLine], ["drop.tmp", ".gitignore", 2]] as const) {
        assert.match(await named(path) ?? "", new RegExp(`^Git ignores it \\(\`${file.replaceAll(".", "\\.")}\` line ${line}\\)`, "u"), `${path} names ${file} line ${line}`);
    }
    assert.match(await named("keep.tmp") ?? "", /plurnk \(members\)/u, "a re-included path is untracked, not ignored");

    await asHome("configured", { ".gitconfig": "[core]\n\texcludesFile = ~/my-ignore\n", "my-ignore": "configured.md\n" });
    assert.match(await named("configured.md") ?? "", /^Git ignores it \(`~\/my-ignore` line 1\)/u, "the user's configured excludes file is honored and named");
});

test("{§log-near-miss} a log miss beside real rows names them", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````READ (a.md)````");
    await dispatch("````FIND (a.md) /alpha/````");
    const wrongLeaf = await dispatch("````READ (log:///1/1/1/sh)````");
    assert.equal(wrongLeaf.status, 404);
    assert.equal(wrongLeaf.problem.recovery, "The entry at log:///1/1/1 is `log:///1/1/1/READ`.");
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ)````")).problem.recovery, "Turn 1/1's READ rows are `log:///1/1/1/READ`, `log:///1/1/3/READ`; the entry at log:///1/1/2 is `log:///1/1/2/FIND`.", "the leaf asked for first, then what the guessed sequence holds");
    assert.equal((await dispatch("````KILL (log:///1/1/1/sh)````")).problem.recovery, "The entry at log:///1/1/1 is `log:///1/1/1/READ`.", "the curation a 413 demands is told the same");
    // The rtx5070 benchlet's shape (run393): a turn's row asked for at the sequence another row holds.
    assert.equal((await dispatch("````KILL (log:///1/1/1/FIND)````")).problem.recovery, "Turn 1/1's FIND rows are `log:///1/1/2/FIND`, `log:///1/1/4/FIND`; the entry at log:///1/1/1 is `log:///1/1/1/READ`.");
    assert.equal((await dispatch("````READ (log:///1/1/9/FIND)````")).problem.recovery, "Turn 1/1's FIND rows are `log:///1/1/2/FIND`, `log:///1/1/4/FIND`.", "a sequence off names the turn's rows that carry the leaf");
    assert.equal((await dispatch("````READ (log:///1/4/1/READ)````")).problem.recovery, "Turn 1/4 has no entries; loop 1's latest turn is 1/1.");
    assert.equal((await dispatch("````READ (log:///7/1/1/READ)````")).problem.recovery, undefined, "a loop with no rows has nothing to name");
});

test("{§unregistered-scheme-recovery} {§diagnostic-observation} an unregistered scheme names what is registered, whatever its authority", async (t) => {
    const { dispatch } = await runtime(t);
    const executorAuthority = await dispatch("````WORK (tool://sh/run)\nls\n````");
    assert.equal(executorAuthority.status, 501);
    assert.equal(executorAuthority.problem.detail, "Scheme 'tool' is not registered.");
    const listed = await dispatch("````READ (nosuch://x/y)````");
    for (const refused of [executorAuthority, listed]) assert.match(refused.problem.recovery ?? "", /^Registered schemes: .*\bfile\b.*\blog\b.*\.$/u);
});

test("{§fts-word-phrase} {§diagnostic-observation} a full-text query FTS5 refuses carries FTS5's message and the dialect's form", async (t) => {
    const { engine, ids, dispatch } = await runtime(t);
    assert.equal((await dispatch("````EDIT (workspace:///notes.md)\nif all(flags):\n````")).status, 201);
    await engine.warmWorkspaceDerivations(ids.workspaceId);
    const refused = await dispatch("````FIND (workspace:///notes.md) ~all(````");
    assert.equal(refused.status, 400);
    assert.equal(refused.problem.recovery, "An FTS5 query is barewords, \"quoted phrases\", and AND, OR, NOT and NEAR between them.");
});

test("{§exec-lifetime} {§diagnostic-observation} an execution that outlives its lifetime says so, and nothing more", async (t) => {
    const { db, ids, dispatch, sequence } = await runtime(t);
    assert.equal((await dispatch("````sh [{\"lifetime\": \"1s\"}]\nsleep 5\n````")).status, 200);
    const stream = await executionAddress(db, ids.turnId, sequence());
    let ended: { status: number; problem: Problem } | undefined;
    for (let attempt = 0; attempt < 60 && ended === undefined; attempt++) {
        await new Promise((settle) => setTimeout(settle, 250));
        const read = await dispatch(`\`\`\`\`READ (${stream})\`\`\`\``);
        if (read.status === 504) ended = read;
    }
    assert.ok(ended, "the deadline closes the stream with 504");
    assert.equal(ended.problem.detail, "Execution of 'sh' outlived its 1s lifetime.");
    assert.equal(ended.problem.recovery, undefined);
});

test("{§exec-near-miss} an execution id written under another runtime names the address it holds", async (t) => {
    const { db, ids, dispatch, sequence } = await runtime(t);
    assert.equal((await dispatch("````python3\nprint(1)\n````")).status, 200);
    const stream = await executionAddress(db, ids.turnId, sequence());
    const id = stream.replace(/^python3:\/\/\//u, "");
    const killed = await dispatch(`\`\`\`\`KILL (sh:///${id})\`\`\`\``);
    assert.equal(killed.status, 404);
    assert.equal(killed.problem.detail, `No stream exists at sh:///${id}.`);
    assert.equal(killed.problem.recovery, `The execution at /${id} is \`${stream}\`.`);
});
