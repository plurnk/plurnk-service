// {§fs-canonical-name} {§fs-answer-in-canon} — accepted spellings converge on one
// stored git pathspec; engine-authored addresses render that same canonical form.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStatement, EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import File from "../../src/schemes/File.ts";
import Namespace from "../../src/core/namespace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES, rootWorkspace } from "./_helpers.ts";

const fileUrl = (pathname: string): UrlPath => ({
    kind: "url", raw: `file://${pathname}`, scheme: "file",
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const readStmt = (pathname: string): ReadStatement => ({ op: "READ", suffix: "", signal: null, target: fileUrl(pathname), lineMarker: null, body: null, position: { line: 1, column: 1 } });
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (pathname: string, body: string, marker: LineMarker | null = null): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target: fileUrl(pathname), lineMarker: marker, body, position: { line: 1, column: 1 } } as unknown as EditStatement);

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
        await EntryCrud.writeEntry("src/main.js", { channels: { body: { content: "the one file\n", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");

        const rootBase = root; // e.g. /tmp/plurnk-canon-XXXX
        const spellings = ["src/main.js", "/src/main.js", "./src/main.js", "src/./main.js", "a/../src/main.js", `../${rootBase.split("/").at(-1)}/src/main.js`];
        for (const spelling of spellings) {
            const r = await new File().read(readStmt(spelling), ctx);
            assert.equal(r.status, 200, `READ(${spelling}) resolves the member`);
            assert.equal(r.content, "the one file\n", `READ(${spelling}) reads the SAME row`);
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "src/main.js" });
        assert.equal(rows?.n, 1, "one identity under every spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-answer-in-canon}: EDIT through an alias answers canonically without minting a shadow row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "note.md"), "original\n");
        const seeded = await db.crud_insert_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: "note.md" });
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
        await EntryCrud.writeEntry("a.md", { channels: { body: { content: "a\n", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");
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
        await EntryCrud.writeEntry("readme.md", { channels: { body: { content: "hello\n", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");

        const Engine = (await import("../../src/core/Engine.ts")).default;
        const SchemeRegistry = (await import("../../src/core/SchemeRegistry.ts")).default;
        const { insertLoop, insertTurn } = await import("./_helpers.ts");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const loopId = await insertLoop(db, (await db.test_first_worker_for_ws.get<{ id: number }>({ workspace_id: workspaceId }))!.id, 1, "go");
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

test("the six-row write matrix — grantor-keyed mounts, O_EXCL create, the blind-write closure", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "plurnk-mount-"));
    try {
        const file = new File();
        const commons = await Owner.commonsId(db, workspaceId);

        // (1) root + empty path, no grantor at all (non-git root, no pick) → the blind-write closure refuses.
        const blind = await file.edit(editStmt("fresh.md", "x\n"), ctx);
        assert.equal(blind.status, 403, "a create whose result would not be a member is refused — plurnk never writes what it cannot see");

        // (1') the client grants via pick → the same create proposes (O_EXCL at an empty path).
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "**" });
        const granted = await file.edit(editStmt("fresh.md", "x\n"), ctx);
        assert.equal(granted.status, 202, "the client grant admits the exclusive create");

        // (3) root + existing NON-member (hidden file) → refused; occupancy is all that leaks.
        await writeFile(join(root, "hidden.md"), "secret\n");
        const hiddenEdit = await file.edit(editStmt("hidden.md", "overwrite\n"), ctx);
        assert.equal(hiddenEdit.status, 403, "an existing non-member is never overwritten — the hidden file stays protected");

        // (4)+(5) mount members: client-granted rw, git-included ro. Register both grantor shapes.
        await writeFile(join(outside, "client.md"), "client-granted\n");
        await writeFile(join(outside, "gitted.md"), "git-included\n");
        const mountKeyClient = `../${outside.split("/").at(-1)}/client.md`;
        const mountKeyGit = `../${outside.split("/").at(-1)}/gitted.md`;
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commons, scheme: "file", pathname: mountKeyClient, membership_origin: "client" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commons, scheme: "file", pathname: mountKeyGit, membership_origin: "git" });
        const rw = await file.edit(editStmt(mountKeyClient, "revised\n", fullReplace), ctx);
        assert.equal(rw.status, 202, "a client-granted mount member is read-write — the per-file rw bind mount");
        const ro = await file.edit(editStmt(mountKeyGit, "revised\n"), ctx);
        assert.equal(ro.status, 403, "a git-included mount member is read-only — git grants rw only within the project");

        // (6) mount + create → refused, always: only the root mints.
        const mint = await file.edit(editStmt(`../${outside.split("/").at(-1)}/new.md`, "x\n"), ctx);
        assert.equal(mint.status, 403, "no mount ever mints — only the root creates");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-errno}: facts distinguish a wrong address, occupancy, and an empty survey", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "real.md"), "content\n");
        await EntryCrud.writeEntry("real.md", { channels: { body: { content: "content\n", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");
        const file = new File();

        // ENOENT on a READ miss carries the resolved name in wire canon.
        const miss = await file.read(readStmt("/no/such.md"), ctx);
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.detail, "No entry exists at no/such.md.", "the READ miss states its fact — resolved form, wire canon");

        // Exact-path FIND distinguishes absence from a successful empty survey.
        const findMissStmt = { op: "FIND", suffix: "", signal: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "no/such.md" }, body: null } as never;
        const findMiss = await file.find(findMissStmt, ctx);
        assert.equal(findMiss.status, 404, "FIND over an absent exact path cannot certify an empty set");
        assert.equal(findMiss.problem?.detail, "No entry exists at no/such.md.");

        // A FOLDER scope with zero matches stays the blessed orienting empty survey.
        const surveyStmt = { op: "FIND", suffix: "", signal: null, lineMarker: null, position: { line: 1, column: 1 },
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

test("the accept stamps the grantor the closure proved — provenance never waits for the reconcile", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "**" });
        const file = new File();
        const proposal = await file.edit(editStmt("stamped.md", "content\n"), ctx);
        assert.equal(proposal.status, 202);
        assert.equal((proposal.attrs as { admittedBy?: string }).admittedBy, "client", "the closure names WHO admitted");
        const applied = await file.applyResolution({ attrs: proposal.attrs as never, body: undefined }, ctx);
        assert.equal(applied.status, 200);
        const row = await db.test_get_origin.get<{ membership_origin: string | null }>({ workspace_id: workspaceId, pathname: "stamped.md" });
        assert.equal(row?.membership_origin, "client", "the accepted create carries its PROVEN grantor, not NULL");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("an in-root file no grantor admits DOES NOT EXIST; a client pick brings it into existence", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        // A real file, physically in the root — non-git root, no pick: NO grantor admits it.
        await writeFile(join(root, "ungran.md"), "present on disk, absent in the world\n");
        const file = new File();
        const invisible = await file.read(readStmt("ungran.md"), ctx);
        assert.equal(invisible.status, 404, "no grantor → the file does not exist for the model (counterintuitive on purpose — the sandbox's center)");

        // The client grants (pick) + the membership pass runs → it exists.
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "ungran.md" });
        const GitMembership = (await import("../../src/core/git-membership.ts")).default;
        await GitMembership.indexGitMembership(ctx);
        const visible = await file.read(readStmt("ungran.md"), ctx);
        assert.equal(visible.status, 200, "the client's explicit grant is what brings it into existence — every visible byte traces to an external grantor");
        assert.match(visible.content ?? "", /present on disk/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
