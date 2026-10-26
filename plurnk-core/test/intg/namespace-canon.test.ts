// {§fs-canonical-name} {§fs-answer-in-canon} — accepted spellings converge on one
// stored Git-relative key; rendered addresses resolve back to that identity.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { FindStatement, ReadStatement, LineMarker, ParsedPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import File from "../../src/schemes/File.ts";
import Namespace from "../../src/core/namespace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import GitMembership from "../../src/core/git-membership.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { openMigrated, insertWorkspace, insertWorker, rootWorkspace } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, readThroughScheme } from "./_scheme.ts";
import { testExecutors } from "./_execs.ts";
import { resourcePaths } from "./_find.ts";

const filePath = (pathname: string): ParsedPath => ({ kind: "local", raw: pathname });
const readStmt = (pathname: string): ReadStatement => ({ metadata: null, op: "READ", aside: null, target: filePath(pathname), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } });
const readFileScheme = (statement: ReadStatement, ctx: ReturnType<typeof makeSchemeCtx>) =>
    readThroughScheme("file", null, statement, ctx);
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (pathname: string, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({ metadata: null, op: "EDIT", aside: null, target: filePath(pathname), lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 } });

const setup = async (databasePath?: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-canon-"));
    const db = await openMigrated(databasePath);
    const workspaceId = await insertWorkspace(db, `canon-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
    return { root, db, workspaceId, ctx };
};

for (const glob of ["**", "~/**"]) test(`{§fs-home} literal membership glob ${glob} composes with discovery, FTS and exclusion`, async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "~"));
        await writeFile(join(root, "~/a.md"), "alpha\n");
        await writeFile(join(root, "~/b.md"), "beta\n");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob, source: "members" });
        await GitMembership.indexGitMembership(ctx);
        const file = new File();
        const find = (pathname: string): FindStatement => ({ ...readStmt(pathname), op: "FIND", lineMarker: null });
        const catalog = await file.find(find("*"), ctx);
        assert.equal(catalog.status, 200);
        assert.ok(JSON.stringify(catalog.results).includes('"path":"./~/**"'), "folder selectors are reusable literal addresses");
        for (const target of ["./~", "./~/", "./~/**", "**"]) {
            const found = await file.find(find(target), ctx);
            assert.equal(found.status, 200, target);
            assert.deepEqual(resourcePaths(found).toSorted(), ["./~/a.md", "./~/b.md"]);
            for (const path of resourcePaths(found)) {
                const read = await readFileScheme(readStmt(path), ctx);
                assert.equal(read.status, 200, path);
                assert.equal(read.content, path.endsWith("a.md") ? "alpha\n" : "beta\n");
            }
        }
        const directory = await readFileScheme(readStmt("./~"), ctx);
        assert.equal(directory.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-is-directory");
        assert.equal(directory.problem?.target, "./~");
        assert.equal(directory.problem?.recovery, "`FIND (./~/)` lists its files.");
        await SearchIndex.maintain(ctx);
        const searched = await file.find({ ...find("./~/**"), matcher: { dialect: "fts", raw: "~alpha" } }, ctx);
        assert.equal(searched.status, 200);
        assert.deepEqual(resourcePaths(searched), ["./~/a.md"], "the pattern-slot tilde remains FTS");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "~/b.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        assert.deepEqual(resourcePaths(await file.find(find("**"), ctx)), ["./~/a.md"]);
        assert.equal(await readFile(join(root, "~/b.md"), "utf8"), "beta\n", "exclusion changes membership, not disk");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const key of ["~", "~/note.md"]) test(`{§fs-home} retained ${key} identity and pending proposal survive reopening unchanged`, async () => {
    const databasePath = join(await testArtifactDirectory("core"), `home-identity-${crypto.randomUUID()}.db`);
    const { root, db, workspaceId, ctx } = await setup(databasePath);
    try {
        await mkdir(dirname(join(root, key)), { recursive: true });
        await writeFile(join(root, key), "original\n");
        const seeded = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: key });
        assert.ok(seeded);
        await MembershipMaterialization.materializeMember(key, root, ctx, new Map());
        const file = new File();
        const proposal = await file.edit(editStmt(`./${key}`, "revised\n", fullReplace), ctx);
        assert.equal(proposal.status, 202);
        assert.equal((proposal.attrs as { path: string }).path, key, "proposal storage retains its bound literal key");
        await db.close();
        const reopened = await openMigrated(databasePath);
        try {
            const restored = { ...ctx, db: reopened };
            assert.equal((await file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, restored)).status, 200);
            const read = await readFileScheme(readStmt(`./${key}`), restored);
            assert.equal(read.status, 200);
            assert.equal(read.content, "revised\n");
            const retained = await reopened.crud_get_member_sig.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: key });
            assert.equal(retained?.id, seeded.id);
            assert.deepEqual(await reopened.test_file_pathnames.all({ workspace_id: workspaceId }), [{ pathname: key }]);
        } finally { await reopened.close(); }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-canonical-name}: every spelling of one member resolves to the same row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/main.js"), "the one file\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/main.js" }, { channels: { body: { content: "the one file\n", mimetype: "text/markdown" } } }, ctx, "file");

        const rootBase = root; // e.g. /tmp/plurnk-canon-XXXX
        const spellings = ["src/main.js", join(root, "src/main.js"), "./src/main.js", "src/./main.js", "a/../src/main.js", `../${rootBase.split("/").at(-1)}/src/main.js`];
        for (const spelling of spellings) {
            const r = await readFileScheme(readStmt(spelling), ctx);
            assert.equal(r.status, 200, `READ(${spelling}) resolves the member`);
            assert.equal(r.content, "the one file\n", `READ(${spelling}) reads the SAME row`);
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "src/main.js" });
        assert.equal(rows?.n, 1, "one identity under every spelling");
        const outside = await readFileScheme(readStmt("/src/main.js"), ctx);
        assert.equal(outside.status, 404, "an absolute miss never falls back to the in-root member");
        assert.equal(outside.problem?.target, "/src/main.js", "{§file-path-normalization} beyond the root the address is the absolute path, never a climb");
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
        const seeded = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: "note.md" });
        assert.ok(seeded);
        await MembershipMaterialization.materializeMember("note.md", root, ctx, new Map());
        const before = await db.test_entries_count_all.get<{ n: number }>({});

        const r = await new File().edit(editStmt(join(root, "note.md"), "revised\n", fullReplace), ctx);
        assert.equal(r.status, 202, "the slashed spelling proposes against the member");
        const attrs = r.attrs as { path: string };
        assert.equal(attrs.path, "note.md", "the engine answers in wire canon — never an echo of the model's spelling");
        assert.match((r as { body?: string }).body ?? "", /^Index: note\.md/, "the diff header speaks canon");

        const after = await db.test_entries_count_all.get<{ n: number }>({});
        assert.equal(after?.n, before?.n, "no shadow row is minted via the alternate spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-canonical-name} the storage fixpoint: every file-class row is its own canon", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "a.md" }, { channels: { body: { content: "a\n", mimetype: "text/markdown" } } }, ctx, "file");
        const rows = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.ok(rows.length > 0);
        for (const { pathname } of rows) {
            assert.ok(Namespace.isCanonical(pathname, root), `stored key '${pathname}' is its own canon — the resource-state predicate`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-canonical-name} the log row: address columns speak canon while tx retains non-sensitive authored spelling", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "readme.md"), "hello\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "readme.md" }, { channels: { body: { content: "hello\n", mimetype: "text/markdown" } } }, ctx, "file");

        const Engine = (await import("../../src/core/Engine.ts")).default;
        const SchemeRegistry = (await import("../../src/core/SchemeRegistry.ts")).default;
        const { insertLoop, insertTurn } = await import("./_db.ts");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const loopId = await insertLoop(db, ctx.workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spelling = `${root}/./readme.md`; // a deliberately ugly legal spelling
        const r = await engine.dispatch({
            statement: readStmt(spelling), workspaceId, workerId: ctx.workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 200, "the ugly spelling resolves");
        const row = await db.test_last_log_row.get<{ pathname: string | null; tx: string }>({ loop_id: loopId });
        assert.equal(row?.pathname, "readme.md", "the engine-authored pathname COLUMN carries wire canon");
        assert.ok(row?.tx.includes("/./readme.md"), "the durable projection retains non-sensitive authored spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-write-outside} {§fs-create-root} {§fs-write-surface}: canonical root and outside-member writes obey the admission matrix", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    const outside = await mkdtemp(join(homedir(), "plurnk-mount-"));
    try {
        const file = new File();

        // (1) root + empty path, no Git and no pick → the root grants exclusive
        // creation. Accepting the proposal establishes the resulting membership.
        const rootCreate = await file.edit(editStmt("fresh.md", "x\n"), ctx);
        assert.equal(rootCreate.status, 202, "the project root admits an exclusive create without another membership grantor");
        const rootApplied = await file.applyResolution({ attrs: rootCreate.attrs as never, metadata: null }, ctx);
        assert.equal(rootApplied.status, 200);
        const rootMember = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "fresh.md",
        });
        assert.equal(rootMember?.membership_origin, "constraint", "the accepted create remains an addressable picked member");
        const rootRead = await readFileScheme(readStmt("fresh.md"), ctx);
        assert.equal(rootRead.status, 200);
        assert.equal(rootRead.content, "x\n");

        // (1') a member definition remains a valid admission path.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "**", source: "members" });
        const granted = await file.edit(editStmt("picked.md", "x\n"), ctx);
        assert.equal(granted.status, 202, "the member definition admits the exclusive create");

        // (3) root + existing NON-member (hidden file) → refused; occupancy is all that leaks.
        await writeFile(join(root, "hidden.md"), "secret\n");
        const hiddenEdit = await file.edit(editStmt("hidden.md", "overwrite\n"), ctx);
        assert.equal(hiddenEdit.status, 403, "an existing non-member is never overwritten — the hidden file stays protected");

        // Outside members: pick-granted rw, Git-only ro. Register both grantor shapes.
        await writeFile(join(outside, "client.md"), "client-granted\n");
        await writeFile(join(outside, "gitted.md"), "git-included\n");
        const mountKeyClient = relative(root, join(outside, "client.md"));
        const mountKeyGit = relative(root, join(outside, "gitted.md"));
        const homePath = (name: string): string => `~/${relative(homedir(), join(outside, name))}`;
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: mountKeyClient, source: "members" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: mountKeyClient, membership_origin: "constraint" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: mountKeyGit, membership_origin: "git" });
        await MembershipMaterialization.materializeMember(mountKeyClient, root, ctx, new Map());
        await MembershipMaterialization.materializeMember(mountKeyGit, root, ctx, new Map());
        for (const pathname of [mountKeyClient, join(outside, "client.md"), homePath("client.md")]) {
            const rw = await file.edit(editStmt(pathname, "revised\n", fullReplace), ctx);
            assert.equal(rw.status, 202, "relative and absolute spellings preserve the outside member's write grant");
            assert.equal((rw.attrs as { path: string }).path, mountKeyClient);
        }
        for (const pathname of [mountKeyGit, join(outside, "gitted.md"), homePath("gitted.md")]) {
            const ro = await file.edit(editStmt(pathname, "revised\n"), ctx);
            assert.equal(ro.status, 403, "absolute spelling cannot expand a Git-only outside member's authority");
        }

        // Default scope is root, so an absent outside path is refused.
        for (const pathname of [relative(root, join(outside, "new.md")), join(outside, "new.md"), homePath("new.md")]) {
            const mint = await file.edit(editStmt(pathname, "x\n"), ctx);
            assert.equal(mint.status, 403, "root scope cannot mint an outside member");
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-errno}: facts distinguish a wrong address, occupancy, and an empty survey", async () => {
    const { root, db, ctx } = await setup();
    try {
        await writeFile(join(root, "real.md"), "content\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "real.md" }, { channels: { body: { content: "content\n", mimetype: "text/markdown" } } }, ctx, "file");
        const file = new File();

        // ENOENT on a READ miss carries the resolved name in wire canon.
        const miss = await readFileScheme(readStmt(join(root, "no/such.md")), ctx);
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.detail, "No member of this workspace is at 'no/such.md'.", "the READ miss states its fact — resolved form, wire canon"); // {§problems-file}
        assert.equal(miss.problem?.recovery, "FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body."); // {§problems-file}

        // Exact-path FIND distinguishes absence from a successful empty survey.
        const findMissStmt = { op: "FIND", aside: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "no/such.md" }, matcher: null, body: null } as never;
        const findMiss = await file.find(findMissStmt, ctx);
        assert.equal(findMiss.status, 404, "FIND over an absent exact path cannot certify an empty set");
        assert.equal(findMiss.problem?.detail, "No member of this workspace is at 'no/such.md'."); // {§problems-file}

        // A FOLDER scope with zero matches stays the blessed orienting empty survey.
        const surveyStmt = { op: "FIND", aside: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "empty-dir/" }, matcher: null, body: null } as never;
        const survey = await file.find(surveyStmt, ctx);
        assert.equal(survey.status, 200, "an empty folder survey is orienting, not an error");

        // Occupancy (EEXIST-class): a hidden non-member at the path — the fact reveals occupancy only.
        await writeFile(join(root, "occupied.md"), "hidden\n");
        const clobber = await file.edit(editStmt("occupied.md", "x\n"), ctx);
        assert.equal(clobber.status, 403);
        assert.equal(clobber.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-occupied-by-nonmember");
        assert.equal(clobber.problem?.detail, "A non-member file already occupies 'occupied.md'."); // {§problems-file}
        assert.equal(clobber.problem?.path, "occupied.md");
        // {§membership-read-refusal} — a READ of that same non-member names the door, not absence.
        const peek = await readFileScheme(readStmt("occupied.md"), ctx);
        assert.equal(peek.status, 404);
        assert.equal(peek.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-member");
        assert.equal(peek.problem?.detail, "'occupied.md' exists on disk but is not a member of this workspace."); // {§pinned-wording-core}
        assert.equal(peek.problem?.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body."); // {§pinned-wording-core}
        assert.equal(clobber.problem?.recovery, "Choose an unoccupied member path."); // {§problems-file}
        assert.equal(clobber.problem?.retryable, false);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§file-find-directory}: directory recognition does not probe outside-root paths", async () => {
    const { root, db, ctx } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-directory-"));
    try {
        const target = `../${outside.split("/").at(-1)}`;
        const statement: FindStatement = {
            metadata: null, op: "FIND", aside: null, target: filePath(target),
            lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
        };
        const result = await new File().find(statement, ctx);
        assert.equal(result.status, 404, "an unmounted outside directory is not recognized from disk");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(result.problem?.detail, `No member of this workspace is at '${resolve(root, target)}'.`, "{§file-path-normalization} named by its absolute address");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§membership-read-refusal}: beyond the root a miss is the same sentence whether or not a file is there", async () => {
    const { root, db, ctx } = await setup();
    const present = `plurnk-dark-${crypto.randomUUID()}.md`;
    const absent = `plurnk-dark-${crypto.randomUUID()}.md`;
    try {
        // A real file beside the root, and a name nothing holds. Neither is a member.
        await writeFile(join(root, "..", present), "somebody else's\n");
        const there = await readFileScheme(readStmt(`../${present}`), ctx);
        const notThere = await readFileScheme(readStmt(`../${absent}`), ctx);
        for (const [result, name] of [[there, present], [notThere, absent]] as const) {
            assert.equal(result.status, 404);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
            const address = resolve(root, "..", name);   // {§file-path-normalization} absolute beyond the root
            assert.equal(result.problem?.detail, `No member of this workspace is at '${address}'.`, "about the address's membership: it neither claims absence nor hints at presence");
            assert.equal(result.problem?.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`, "the recovery speaks of the address too, true under every members scope (#1005)"); // {§problems-file}
        }
        // The disk beyond the root stays dark: swap the names and the two answers are one answer,
        // apart from where each refused read was recorded.
        const normalize = (result: typeof there, name: string): string => {
            const { instance, ...problem } = result.problem!;
            assert.ok(instance, "each refused read is its own recorded act");
            return JSON.stringify({ ...result, problem }).replaceAll(name, "<name>");
        };
        assert.equal(normalize(there, present), normalize(notThere, absent));
    } finally {
        await rm(join(root, "..", present), { force: true });
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§fs-create-incorporation}: accept records constraint provenance before reporting success", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "**", source: "members" });
        const file = new File();
        const proposal = await file.edit(editStmt("stamped.md", "content\n"), ctx);
        assert.equal(proposal.status, 202);
        const applied = await file.applyResolution({ attrs: proposal.attrs as never, body: undefined, metadata: null }, ctx);
        assert.equal(applied.status, 200);
        const row = await db.test_get_origin.get<{ membership_origin: string | null }>({ workspace_id: workspaceId, pathname: "stamped.md" });
        assert.equal(row?.membership_origin, "constraint", "the accepted create carries its represented grantor, not NULL");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-canonical-name} an in-root file no grantor admits DOES NOT EXIST; a client pick brings it into existence", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        // A real file, physically in the root — non-git root, no pick: NO grantor admits it.
        await writeFile(join(root, "ungran.md"), "present on disk, absent in the workspace\n");
        const invisible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(invisible.status, 404, "no grantor → the file does not exist for the model (counterintuitive on purpose — the sandbox's center)");

        // A member definition grants it + the membership pass runs → it exists.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "ungran.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        const visible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(visible.status, 200, "the client's explicit grant is what brings it into existence — every visible byte traces to an external grantor");
        assert.match(visible.content ?? "", /present on disk/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§problems-file} {§diagnostic-observation} a file target named like an executor misses like any path, presuming no fence (#902)", async () => {
    const { root, db, ctx } = await setup();
    try {
        const executors = await testExecutors();
        assert.ok(executors.availableRuntimes(ctx.workspaceId).includes("sh"), "the real shell executor is available to the fixture");
        const withExecutors = { ...ctx, executors };
        for (const key of ["sh", "nope", "tools/sh"]) {
            const miss = await readFileScheme(readStmt(key), withExecutors);
            assert.equal(miss.status, 404, key);
            assert.equal(miss.problem?.recovery, "FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.", key);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
