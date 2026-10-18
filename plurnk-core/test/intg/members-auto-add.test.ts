// {§membership-auto-add}: the matrix — READ and FIND, an exact path and a glob, each row of the universe
// table, with the knob on and off, the model's scope open and closed, and the proposal settled by policy or
// by a reviewer. A read of content proposes the admission; acceptance admits and reads; rejection admits
// nothing; a listing admits nothing; nothing unadmitted shows its content; the client's reads never admit.
import { ownWorker, serverProposals, TEST_OWNER } from "./_approval.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import type { Db } from "../../src/core/Db.ts";
import { fixtureExecutors } from "./_mock.ts";
import { insertWorkspace, insertWorker, openMigrated, rootWorkspace } from "./_db.ts";
import { modelOperation } from "./_workers.ts";

const execFileP = promisify(execFile);

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

// tracked: README.md. Untracked and unignored: loose.md, loose2.md (excluded by definition), docs/guide.md,
// blob.bin. Ignored: ignored.log. A directory: docs.
const project = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-auto-add-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.log\n");
    await writeFile(join(root, "README.md"), "# tracked\nalpha\n");
    await git(["add", ".gitignore", "README.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "chore: seed"]);
    await writeFile(join(root, "loose.md"), "# loose\nalpha\n");
    await writeFile(join(root, "loose2.md"), "# loose two\nalpha\n");
    await writeFile(join(root, "ignored.log"), "alpha secret\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# guide\nbeta\n");
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 255, 129, 10, 0, 1]));
    return root;
};

const memberOf = async (db: Db, workspaceId: number, pathname: string): Promise<boolean> =>
    (await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname })) !== undefined;

type Definition = { alias: string; origin: string; state: string; definition?: { glob: string; provenance?: { kind: string } } };

const harness = async (t: TestContext, env: Record<string, string>) => {
    serverProposals(t, "accept");
    const root = await project();
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const notices: string[] = [];
    type Proposal = { logEntryId: number; op: string; body?: string };
    const proposals: Proposal[] = [];
    const waiting: Array<(proposal: Proposal) => void> = [];
    daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") {
            const proposal = params as Proposal;
            const waiter = waiting.shift();
            if (waiter === undefined) proposals.push(proposal); else waiter(proposal);
            return;
        }
        if (method !== "notice/event") return;
        const text = JSON.stringify(params);
        if (text.includes("member_added")) notices.push(text);
    });
    // {§proposal-202-pauses} — under review the dispatch pauses on the proposal until a decision arrives.
    const nextProposal = (): Promise<Proposal> => {
        const queued = proposals.shift();
        return queued !== undefined ? Promise.resolve(queued) : new Promise((resolve) => { waiting.push(resolve); });
    };
    const workspaceId = await insertWorkspace(db, `auto-add-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId, null, "model", "model");
    const restore = await (async () => {
        const overrides = {
            PLURNK_SERVICE_GIT_ALLOWED: "1", PLURNK_SERVICE_GIT_AUTO: "1", PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace",
            PLURNK_MEMBERS_ENABLED: "1", PLURNK_MEMBERS_no_two: "!loose2.md", PLURNK_MEMBERS_AUTO_ADD: "1", ...env,
        };
        const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
        for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
        return () => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
    })();
    await daemon.start();
    t.after(async () => { await daemon.stop(); await db.close(); restore(); await rm(root, { recursive: true, force: true }); });
    const model = (program: string) => modelOperation(daemon, db, { workspaceId, workerId, statement: parseOne(program) });
    const client = async (program: string) => (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne(program)] }))[0]!;
    const definitions = async (): Promise<Definition[]> =>
        (await daemon.invokeModuleAction("workspace.members.list", {}, { scope: "workspace", workspaceId }) as { definitions: Definition[] }).definitions;
    const member = (pathname: string) => memberOf(db, workspaceId, pathname);
    const paths = (result: { results?: unknown }): string => JSON.stringify(result.results ?? []);
    const review = async (program: string, decision: "accept" | "reject"): Promise<{ result: unknown; proposal: Proposal }> => {
        const pending = model(program);
        const proposal = await nextProposal();
        await daemon.engine.resolveProposal(proposal.logEntryId, { decision }, TEST_OWNER);
        return { result: await pending, proposal };
    };
    // A person reviews: the worker is owned by an interactive client, and the server disposition is review.
    const attend = async (): Promise<void> => { await ownWorker(db, workspaceId, workerId); serverProposals(t, "review"); };
    return { db, daemon, workspaceId, workerId, notices, model, client, definitions, member, paths, review, attend };
};

test("{§membership-auto-add} READ: an untracked file is admitted as the Worker's own definition and read; ignored, excluded, beyond-root and directory targets are not", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    const read = await h.model("````READ (loose.md)````") as { status: number; content?: string | null };
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.match(String(read.content), /# loose/u, "the admitted file is read in the same operation");
    assert.equal(await h.member("loose.md"), true);
    const admitted = (await h.definitions()).find(({ alias }) => alias === "loose.md");
    assert.equal(admitted?.origin, "workspace");
    assert.equal(admitted?.definition?.provenance?.kind, "model-proposal", "the admission is the model's own add");
    assert.equal(admitted?.state, "active");
    assert.equal(h.notices.length, 1, `one member_added notice: ${JSON.stringify(h.notices)}`);
    assert.match(h.notices[0]!, /'loose\.md' is now a member of this workspace\./u);
    assert.match(h.notices[0]!, /"level":"warn"/u);
    assert.doesNotMatch(h.notices[0]!, /"directive"/u, "the notice carries no directive");

    for (const [program, code, pathname] of [
        ["````READ (ignored.log)````", "entry-not-member", "ignored.log"],
        ["````READ (loose2.md)````", "entry-not-member", "loose2.md"],
        ["````READ (../outside.md)````", "entry-not-found", "../outside.md"],
        ["````READ (docs)````", "path-is-directory", "docs"],
    ] as const) {
        const refused = await h.model(program) as { status: number; problem?: { type?: string } };
        assert.equal(refused.status, 404, `${program}: ${JSON.stringify(refused)}`);
        assert.match(refused.problem?.type ?? "", new RegExp(`/${code}$`, "u"), program);
        assert.equal(await h.member(pathname), false, `${pathname} is never admitted`);
    }
    assert.equal(h.notices.length, 1, "the refusals announce nothing");
});

test("{§membership-auto-add} READ by glob: the universe fans out, and each untracked file read is admitted", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    await h.model("````READ (*.md) <1,2>````");
    assert.equal(await h.member("loose.md"), true, "the untracked file the glob reached was admitted");
    assert.equal(await h.member("loose2.md"), false, "an excluded file is outside the universe");
    assert.equal(await h.member("ignored.log"), false);
    assert.equal(h.notices.length, 1);
});

test("{§membership-auto-add} FIND: a listing shows the universe without admitting; a text match admits; indexed dialects and binary candidates see members only", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.equal(listed.status, 200, JSON.stringify(listed));
    const listing = h.paths(listed);
    for (const shown of ["README.md", "loose.md", "blob.bin"]) assert.match(listing, new RegExp(`"${shown}"`, "u"), `${shown} is listed`);
    for (const hidden of ["ignored.log", "loose2.md"]) assert.doesNotMatch(listing, new RegExp(hidden, "u"), `${hidden} is outside the universe`);
    assert.match(listing, /"aside":"untracked"/u, "a listed candidate is marked untracked");
    assert.equal(await h.member("loose.md"), false, "listing admits nothing");
    assert.equal(h.notices.length, 0);

    const exact = await h.model("````FIND (loose.md)````") as { status: number };
    assert.equal(exact.status, 200, "an exact FIND of a candidate lists it rather than missing");
    assert.equal(await h.member("loose.md"), false);

    const fulltext = await h.model("````FIND (*) ~alpha````") as { status: number; results?: unknown };
    assert.equal(fulltext.status, 200, JSON.stringify(fulltext));
    assert.match(h.paths(fulltext), /README\.md/u);
    assert.doesNotMatch(h.paths(fulltext), /loose\.md/u, "an indexed dialect sees members only");
    assert.equal(await h.member("loose.md"), false);

    const matched = await h.model("````FIND (*.md) loose````") as { status: number; results?: unknown };
    assert.equal(matched.status, 200, JSON.stringify(matched));
    assert.match(h.paths(matched), /loose\.md/u, "the candidate whose text matched is in the result");
    assert.doesNotMatch(h.paths(matched), /README\.md|loose2\.md/u);
    assert.equal(await h.member("loose.md"), true, "a text match admits");
    assert.equal(await h.member("docs/guide.md"), false, "an unmatched candidate stays out");
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0]!, /'loose\.md' is now a member/u);

    const nested = await h.model("````FIND (docs/*.md) beta````") as { status: number; results?: unknown };
    assert.equal(nested.status, 200);
    assert.equal(await h.member("docs/guide.md"), true, "a scoped glob reaches its directory's candidates");
    assert.equal(h.notices.length, 2);
});

test("{§membership-auto-add} scope none: the universe is listed, nothing is admitted, and no unadmitted content shows", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none" });
    const read = await h.model("````READ (loose.md)````") as { status: number; problem?: { type?: string; recovery?: string } };
    assert.equal(read.status, 404);
    assert.match(read.problem?.type ?? "", /entry-not-member$/u);
    assert.equal(await h.member("loose.md"), false);
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.match(h.paths(listed), /loose\.md/u, "occupancy inside the root is not secret");
    const matched = await h.model("````FIND (*.md) loose````") as { status: number; results?: unknown };
    assert.equal(matched.status, 204, "the only match was on what the scope refuses to admit, so nothing matched");
    assert.doesNotMatch(h.paths(matched), /loose\.md/u, "a match on what the scope refuses to admit is not shown");
    assert.equal(await h.member("loose.md"), false);
    assert.equal(h.notices.length, 0);
});

test("{§membership-auto-add} knob off: today's contract holds unchanged", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, { PLURNK_MEMBERS_AUTO_ADD: "0" });
    const read = await h.model("````READ (loose.md)````") as { status: number; problem?: { type?: string; recovery?: string } };
    assert.equal(read.status, 404);
    assert.match(read.problem?.type ?? "", /entry-not-member$/u);
    assert.equal(read.problem?.recovery, "Admit it with `members (add)` and a `{\"files\": [\"<path>\"]}` body.");
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.doesNotMatch(h.paths(listed), /loose\.md/u, "members only");
    const matched = await h.model("````FIND (*.md) loose````") as { status: number; results?: unknown };
    assert.doesNotMatch(h.paths(matched), /loose\.md/u);
    assert.equal(await h.member("loose.md"), false);
    assert.equal(h.notices.length, 0);
});

test("{§membership-auto-add} {§proposal-202-pauses} under review, a READ proposes the admission: accepted, it admits and reads; rejected, it admits nothing", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    await h.attend();
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.match(h.paths(listed), /loose\.md/u, "the universe is listed under review; listing proposes nothing");
    assert.equal(await h.member("loose.md"), false);

    const accepted = await h.review("````READ (loose.md)````", "accept");
    assert.equal(accepted.proposal.op, "READ");
    assert.equal(accepted.proposal.body, JSON.stringify({ files: ["loose.md"] }), "the review material is the definition the acceptance admits");
    const read = accepted.result as { status: number; content?: string | null };
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.match(String(read.content), /# loose/u, "the accepted admission reads the file in the same operation");
    assert.equal(await h.member("loose.md"), true);
    assert.equal((await h.definitions()).find(({ alias }) => alias === "loose.md")?.definition?.provenance?.kind, "model-proposal");
    assert.equal(h.notices.length, 1, "one member_added notice");

    const rejected = await h.review("````READ (docs/guide.md)````", "reject");
    const refused = rejected.result as { status: number; outcome?: string; problem?: { detail?: string } };
    assert.equal(refused.status, 400, JSON.stringify(refused));
    assert.equal(refused.outcome, "rejected", "{§proposal-reject-fails}");
    assert.match(String(refused.problem?.detail), /rejected/u, "{§proposal-outcome-terse-error}: the detail names the outcome");
    assert.equal(await h.member("docs/guide.md"), false, "a rejected admission admits nothing");
    assert.equal(h.notices.length, 1, "and announces nothing");
    const again = await h.review("````READ (docs/guide.md) <1,1>````", "reject");
    assert.equal(again.proposal.op, "READ", "a rejection does not retire the file from the universe: the next read proposes again");
    assert.equal((again.result as { status: number }).status, 400);
});

test("{§membership-auto-add} under review, a text FIND proposes the admission of what it matched; accepted, the selection runs over the members", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    await h.attend();
    const { result, proposal } = await h.review("````FIND (docs/*.md) beta````", "accept");
    assert.equal(proposal.op, "FIND");
    assert.equal(proposal.body, JSON.stringify({ files: ["docs/guide.md"] }));
    const found = result as { status: number; results?: unknown };
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.match(h.paths(found), /docs\/guide\.md/u, "the admitted file's match shows its evidence");
    assert.equal(await h.member("docs/guide.md"), true);
    assert.equal(h.notices.length, 1);
});

test("{§membership-auto-add} a client's READ never admits on the Worker's behalf", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    const read = await h.client("````READ (loose.md)````") as { status: number };
    assert.equal(read.status, 404);
    assert.equal(await h.member("loose.md"), false);
    assert.equal(h.notices.length, 0);
});
