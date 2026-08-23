// {§fs-canonical-name} {§fs-answer-in-canon} — accepted spellings converge on one
// stored git pathspec; engine-authored addresses render that same canonical form.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import File from "../../src/schemes/File.ts";
import Namespace from "../../src/core/namespace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES, rootWorkspace, lookThroughScheme } from "./_helpers.ts";

const fileUrl = (pathname: string): UrlPath => ({
    kind: "url", raw: `file://${pathname}`, scheme: "file",
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const readStmt = (pathname: string): ReadStatement => ({ op: "READ", annotation: null, delimiter: "", signal: null, target: fileUrl(pathname), lineMarker: null, body: null, position: { line: 1, column: 1 } });
const readFileScheme = (statement: ReadStatement, ctx: ReturnType<typeof makeSchemeCtx>) =>
    lookThroughScheme("file", null, statement, ctx);
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (pathname: string, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({ op: "EDIT", annotation: null, delimiter: "", signal: null, target: fileUrl(pathname), lineMarker: marker, body, position: { line: 1, column: 1 } });

const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-canon-"));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `canon-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
    return { root, db, workspaceId, ctx };
};

test("{§fs-canonical-name}: every spelling of one member resolves to the same row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/main.js"), "the one file\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/main.js" }, { channels: { body: { content: "the one file\n", mimetype: "text/markdown" } } }, ctx, "file", await Owner.commonsId(db, workspaceId));

        const rootBase = root; // e.g. /tmp/plurnk-canon-XXXX
        const spellings = ["src/main.js", "/src/main.js", "./src/main.js", "src/./main.js", "a/../src/main.js", `../${rootBase.split("/").at(-1)}/src/main.js`];
        for (const spelling of spellings) {
            const r = await readFileScheme(readStmt(spelling), ctx);
            assert.equal(r.status, 200, `READ(${spelling}) resolves the member`);
            assert.equal(r.content, "the one file\n", `READ(${spelling}) reads the SAME row`);
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "src/main.js" });
        assert.equal(rows?.n, 1, "one identity under every spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-canonical-name}: repository paths materialize in the workspace namespace", () => {
    assert.equal(Namespace.fromRepositoryPath("project/src/main.js", "/repo/project", "/repo"), "src/main.js");
    assert.equal(Namespace.fromRepositoryPath("sibling/README.md", "/repo/project", "/repo"), "../sibling/README.md");
    assert.throws(() => Namespace.fromRepositoryPath("../escape", "/repo/project", "/repo"), /escapes its repository/);
});

test("{§fs-answer-in-canon}: EDIT through an alias answers canonically without minting a shadow row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "note.md"), "original\n");
        const seeded = await db.crud_insert_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", authority: "", pathname: "note.md" });
        assert.ok(seeded);
        const before = await db.test_entries_count_all.get<{ n: number }>({});

        const r = await new File().edit(editStmt("/note.md", "revised\n", fullReplace), ctx);
        assert.equal(r.status, 202, "the slashed spelling proposes against the member");
        const attrs = r.attrs as { path: string };
        assert.equal(attrs.path, "note.md", "the engine answers in wire canon — never an echo of the model's spelling");
        assert.match((r as { body?: string }).body ?? "", /^Index: note\.md/, "the diff header speaks canon");

        const after = await db.test_entries_count_all.get<{ n: number }>({});
        assert.equal(after?.n, before?.n, "no shadow row is minted via the alternate spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("the storage fixpoint: every file-class row is its own canon", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "a.md" }, { channels: { body: { content: "a\n", mimetype: "text/markdown" } } }, ctx, "file", await Owner.commonsId(db, workspaceId));
        const rows = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.ok(rows.length > 0);
        for (const { pathname } of rows) {
            assert.ok(Namespace.isCanonical(pathname, root), `stored key '${pathname}' is its own canon — the world-state predicate`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("the log row: address columns speak canon while tx retains non-sensitive authored spelling", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "readme.md"), "hello\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "readme.md" }, { channels: { body: { content: "hello\n", mimetype: "text/markdown" } } }, ctx, "file", await Owner.commonsId(db, workspaceId));

        const Engine = (await import("../../src/core/Engine.ts")).default;
        const SchemeRegistry = (await import("../../src/core/SchemeRegistry.ts")).default;
        const { insertLoop, insertTurn } = await import("./_helpers.ts");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const loopId = await insertLoop(db, ctx.workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spelling = "/./readme.md"; // a deliberately ugly legal spelling
        const r = await engine.dispatch({
            statement: readStmt(spelling), workspaceId, workerId: ctx.workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 200, "the ugly spelling resolves");
        const row = await db.test_last_log_row.get<{ pathname: string | null; tx: string }>({ loop_id: loopId });
        assert.equal(row?.pathname, "readme.md", "the engine-authored pathname COLUMN carries wire canon");
        assert.ok(row?.tx.includes("/./readme.md"), "the durable projection retains non-sensitive authored spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-write-surface}: canonical root and outside-member writes obey the admission matrix", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "plurnk-mount-"));
    try {
        const file = new File();
        const commons = await Owner.commonsId(db, workspaceId);

        // (1) root + empty path, no Git and no pick → the root grants exclusive
        // creation. Accepting the proposal establishes the resulting membership.
        const rootCreate = await file.edit(editStmt("fresh.md", "x\n"), ctx);
        assert.equal(rootCreate.status, 202, "the project root admits an exclusive create without another membership grantor");
        const rootApplied = await file.applyResolution({ attrs: rootCreate.attrs as never }, ctx);
        assert.equal(rootApplied.status, 200);
        const rootMember = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "fresh.md",
        });
        assert.equal(rootMember?.membership_origin, "constraint", "the accepted create remains an addressable picked member");
        const rootRead = await readFileScheme(readStmt("fresh.md"), ctx);
        assert.equal(rootRead.status, 200);
        assert.equal(rootRead.content, "x\n");

        // (1') an explicit pick remains a valid admission path.
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "**" });
        const granted = await file.edit(editStmt("picked.md", "x\n"), ctx);
        assert.equal(granted.status, 202, "the explicit pick admits the exclusive create");

        // (3) root + existing NON-member (hidden file) → refused; occupancy is all that leaks.
        await writeFile(join(root, "hidden.md"), "secret\n");
        const hiddenEdit = await file.edit(editStmt("hidden.md", "overwrite\n"), ctx);
        assert.equal(hiddenEdit.status, 403, "an existing non-member is never overwritten — the hidden file stays protected");

        // Outside members: pick-granted rw, Git-only ro. Register both grantor shapes.
        await writeFile(join(outside, "client.md"), "client-granted\n");
        await writeFile(join(outside, "gitted.md"), "git-included\n");
        const mountKeyClient = `../${outside.split("/").at(-1)}/client.md`;
        const mountKeyGit = `../${outside.split("/").at(-1)}/gitted.md`;
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: mountKeyClient });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commons, scheme: "file", authority: "", pathname: mountKeyClient, membership_origin: "constraint" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commons, scheme: "file", authority: "", pathname: mountKeyGit, membership_origin: "git" });
        const rw = await file.edit(editStmt(mountKeyClient, "revised\n", fullReplace), ctx);
        assert.equal(rw.status, 202, "a picked mount member is read-write — the per-file rw bind mount");
        const ro = await file.edit(editStmt(mountKeyGit, "revised\n"), ctx);
        assert.equal(ro.status, 403, "a git-included mount member is read-only — git grants rw only within the project");

        // Default scope is root, so an absent outside path is refused.
        const mint = await file.edit(editStmt(`../${outside.split("/").at(-1)}/new.md`, "x\n"), ctx);
        assert.equal(mint.status, 403, "root scope cannot mint an outside member");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-errno}: facts distinguish a wrong address, occupancy, and an empty survey", async () => {
    const { root, db, ctx, workspaceId } = await setup();
    try {
        await writeFile(join(root, "real.md"), "content\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "real.md" }, { channels: { body: { content: "content\n", mimetype: "text/markdown" } } }, ctx, "file", await Owner.commonsId(db, workspaceId));
        const file = new File();

        // ENOENT on a READ miss carries the resolved name in wire canon.
        const miss = await readFileScheme(readStmt("/no/such.md"), ctx);
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.detail, "No entry exists at no/such.md.", "the READ miss states its fact — resolved form, wire canon");

        // Exact-path FIND distinguishes absence from a successful empty survey.
        const findMissStmt = { op: "FIND", annotation: null, delimiter: "", signal: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "no/such.md" }, body: null } as never;
        const findMiss = await file.find(findMissStmt, ctx);
        assert.equal(findMiss.status, 404, "FIND over an absent exact path cannot certify an empty set");
        assert.equal(findMiss.problem?.detail, "No entry exists at no/such.md.");

        // A FOLDER scope with zero matches stays the blessed orienting empty survey.
        const surveyStmt = { op: "FIND", annotation: null, delimiter: "", signal: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "empty-dir/" }, body: null } as never;
        const survey = await file.find(surveyStmt, ctx);
        assert.equal(survey.status, 200, "an empty folder survey is orienting, not an error");

        // Occupancy (EEXIST-class): a hidden non-member at the path — the fact reveals occupancy only.
        await writeFile(join(root, "occupied.md"), "hidden\n");
        const clobber = await file.edit(editStmt("occupied.md", "x\n"), ctx);
        assert.equal(clobber.status, 403);
        assert.equal(clobber.problem?.type, "https://problems.plurnk.dev/scheme/file/path-occupied-by-nonmember");
        assert.equal(clobber.problem?.detail, "A non-member file already occupies 'occupied.md'.");
        assert.equal(clobber.problem?.path, "occupied.md");
        assert.equal(clobber.problem?.recovery, "Choose an unoccupied member path.");
        assert.equal(clobber.problem?.retryable, false);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-create-incorporation}: accept records constraint provenance before reporting success", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "**" });
        const file = new File();
        const proposal = await file.edit(editStmt("stamped.md", "content\n"), ctx);
        assert.equal(proposal.status, 202);
        const applied = await file.applyResolution({ attrs: proposal.attrs as never, body: undefined }, ctx);
        assert.equal(applied.status, 200);
        const row = await db.test_get_origin.get<{ membership_origin: string | null }>({ workspace_id: workspaceId, pathname: "stamped.md" });
        assert.equal(row?.membership_origin, "constraint", "the accepted create carries its represented grantor, not NULL");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("an in-root file no grantor admits DOES NOT EXIST; a client pick brings it into existence", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        // A real file, physically in the root — non-git root, no pick: NO grantor admits it.
        await writeFile(join(root, "ungran.md"), "present on disk, absent in the world\n");
        const invisible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(invisible.status, 404, "no grantor → the file does not exist for the model (counterintuitive on purpose — the sandbox's center)");

        // The client grants (pick) + the membership pass runs → it exists.
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "ungran.md" });
        const GitMembership = (await import("../../src/core/git-membership.ts")).default;
        await GitMembership.indexGitMembership(ctx);
        const visible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(visible.status, 200, "the client's explicit grant is what brings it into existence — every visible byte traces to an external grantor");
        assert.match(visible.content ?? "", /present on disk/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
