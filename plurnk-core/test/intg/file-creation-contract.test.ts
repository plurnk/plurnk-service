// File creation is one producer-neutral transaction: scope + membership policy admit the
// proposal, exclusive disk creation lands it, and Git or an inspectable pick incorporates it.
// These specimens cover the contract matrices in {§fs-write-surface} and
// {§fs-create-incorporation}, rather than one caller's implementation path.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { LineMarker } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertOperationTurn,
    insertTurn,
    insertWorker,
    insertWorkspace,
    makeSchemeCtx,
    openMigrated,
    rootWorkspace,
    seedStaticChannel,
} from "./_helpers.ts";

const execFileP = promisify(execFile);
const replaceAll: LineMarker = { marks: [1, -1] };
const edit = (pathname: string, body: string, lineMarker: LineMarker | null = null): ResolvedEditStatement => ({
    op: "EDIT",
    annotation: null,
    delimiter: "",
    signal: null,
    target: { kind: "local", raw: pathname },
    lineMarker,
    body,
    position: { line: 1, column: 1 },
});

type Constraint = { effect: string; glob: string; source?: string };

const constraints = (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number) =>
    db.crud_list_workspace_constraints.all<Constraint>({ workspace_id: workspaceId });

const withWorkspace = async (
    fn: (fixture: {
        root: string;
        outside: string;
        file: File;
        db: Awaited<ReturnType<typeof openMigrated>>;
        workspaceId: number;
        ctx: ReturnType<typeof makeSchemeCtx>;
    }) => Promise<void>,
): Promise<void> => {
    const parent = await mkdtemp(join(tmpdir(), "plurnk-create-contract-"));
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `create-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
        await fn({ root, outside, file: new File(), db, workspaceId, ctx });
    } finally {
        await db.close();
        await rm(parent, { recursive: true, force: true });
    }
};

const acceptCreate = async (
    file: File,
    ctx: ReturnType<typeof makeSchemeCtx>,
    pathname: string,
    body: string = "created\n",
) => {
    const proposed = await file.edit(edit(pathname, body), ctx);
    assert.equal(proposed.status, 202, `${pathname} reaches proposal review`);
    const applied = await file.applyResolution({ attrs: proposed.attrs as never }, ctx);
    assert.equal(applied.status, 200, `${pathname} lands completely`);
    return applied;
};

test("{§file-create-producer-neutral}: every runtime producer completes the same reviewed creation", async () => {
    await withWorkspace(async ({ root, db, workspaceId, ctx }) => {
        const loopId = await insertLoop(db, ctx.workerId, 1, "producer-neutral-create");
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            weigh: ctx.weigh,
        });
        for (const [index, origin] of (["model", "client", "plugin", "_plurnk"] as const).entries()) {
            const turnId = origin === "model"
                ? await insertTurn(db, loopId, index + 1)
                : await insertOperationTurn(db, loopId, index + 1, origin);
            let announce!: (logEntryId: number) => void;
            const announced = new Promise<number>((resolve) => { announce = resolve; });
            const dispatch = engine.dispatch({
                statement: edit(`${origin}.md`, `${origin}\n`),
                workspaceId,
                workerId: ctx.workerId,
                loopId,
                turnId,
                sequence: 1,
                origin,
                onDispatch: announce,
            });
            engine.resolveProposal(await announced, { decision: "accept" });
            assert.equal((await dispatch).status, 200, `${origin} crosses review and the complete creation transaction`);
            assert.equal(await readFile(join(root, `${origin}.md`), "utf8"), `${origin}\n`);
        }
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "_plurnk.md", source: "create" },
            { effect: "include", glob: "client.md", source: "create" },
            { effect: "include", glob: "model.md", source: "create" },
            { effect: "include", glob: "plugin.md", source: "create" },
        ]);
    });
});

test("{§file-create-no-orphans}: a naked non-Git workspace create becomes an exact generated pick", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "fresh.md");
        assert.equal(await readFile(join(root, "fresh.md"), "utf8"), "created\n");
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "fresh.md", source: "create" },
        ]);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "fresh.md",
        });
        assert.equal(member?.membership_origin, "constraint");
        const read = await EntryCrud.readEntry(
            { authority: "", pathname: "fresh.md" },
            ctx,
            "file",
            await Owner.commonsId(db, workspaceId),
        );
        assert.equal(read.status, 200, "the creating workspace can immediately address what it wrote");
    });
});

test("{§fs-create-git}: an active Git create is incorporated by an exact generated pick and never staged", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await acceptCreate(file, ctx, "tracked.md");
        await assert.rejects(
            execFileP("git", ["ls-files", "--error-unmatch", "--", "tracked.md"], { cwd: root, env: hermeticGitEnv() }),
            "Plurnk never runs `git add`: the created file stays untracked ({§membership-baseline})",
        );
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "tracked.md", source: "create" },
        ], "the exact generated pick is the incorporation ({§membership-model-universe})");
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "tracked.md",
        });
        assert.equal(member?.membership_origin, "constraint");
    });
});

test("{§file-create-exclusions-win}: ignore, hide, and view refuse automatic creation", async (t) => {
    await t.test("active Git ignore requires an explicit pick", async () => {
        await withWorkspace(async ({ root, file, ctx }) => {
            await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
            await writeFile(join(root, ".gitignore"), "ignored.md\n");
            const result = await file.edit(edit("ignored.md", "secret\n"), ctx);
            assert.equal(result.status, 403);
            await assert.rejects(stat(join(root, "ignored.md")));
        });
    });

    await t.test("an exclusion refuses creation", async () => {
        await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
            await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "blocked.md", source: "members" });
            const result = await file.edit(edit("blocked.md", "blocked\n"), ctx);
            assert.equal(result.status, 403);
            await assert.rejects(stat(join(root, "blocked.md")));
        });
    });
});

test("{§fs-create-ignored}: a member definition overrides Git ignore and leaves no creation record", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, ".gitignore"), "ignored.md\n");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "ignored.md", source: "members" });
        await acceptCreate(file, ctx, "ignored.md");
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "ignored.md", source: "members" },
        ]);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "ignored.md",
        });
        assert.equal(member?.membership_origin, "constraint");
        await assert.rejects(execFileP("git", ["ls-files", "--error-unmatch", "--", "ignored.md"], {
            cwd: root,
            env: hermeticGitEnv(),
        }));
    });
});

test("{§fs-visibility-grantors}: a member definition supersedes Git and cleanly yields it back", async () => {
    await withWorkspace(async ({ root, db, workspaceId, ctx }) => {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "dual.md"), "dual\n");
        await execFileP("git", ["add", "--", "dual.md"], { cwd: root, env: hermeticGitEnv() });
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        const origin = () => db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "dual.md",
        });
        assert.equal((await origin())?.membership_origin, "git");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "dual.md", source: "members" });
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.equal((await origin())?.membership_origin, "constraint", "a member definition owns the represented grant");

        await db.crud_delete_family_workspace_constraints.run({ workspace_id: workspaceId });
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.equal((await origin())?.membership_origin, "git", "removing the definition restores Git ownership");
    });
});

test("{§file-create-scope}: service and workspace scopes compose monotonically", async (t) => {
    const previous = process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE;
        else process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = previous;
    });

    await t.test("none denies a new root file without affecting an existing member edit", async () => {
        process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = "none";
        await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
            const denied = await file.edit(edit("new.md", "new\n"), ctx);
            assert.equal(denied.status, 403);

            await writeFile(join(root, "existing.md"), "before\n");
            const member = await db.crud_register_workspace_member.get<{ id: number }>({
                workspace_id: workspaceId,
                owner_id: await Owner.commonsId(db, workspaceId),
                scheme: "file",
                authority: "",
                pathname: "existing.md",
                membership_origin: "constraint",
            });
            await seedStaticChannel(db, member?.id, {
                name: "body",
                content: "before\n",
                mimetype: "text/markdown",
            });
            const before = await stat(join(root, "existing.md"));
            await db.crud_set_synced_sig.run({ entry_id: member?.id, synced_sig: `${before.mtimeMs}:${before.size}` });
            const existing = await file.edit(edit("existing.md", "after\n", replaceAll), ctx);
            assert.equal(existing.status, 202, "the creation ceiling does not disable existing-member writes");
        });
    });

    await t.test("a workspace cannot widen root to namespace", async () => {
        process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = "root";
        await withWorkspace(async ({ outside, file, db, workspaceId, ctx }) => {
            await db.test_set_workspace_settings.run({
                id: workspaceId,
                settings: JSON.stringify({ fileCreateScope: "namespace" }),
            });
            const key = `../${basename(outside)}/outside.md`;
            const result = await file.edit(edit(key, "outside\n"), ctx);
            assert.equal(result.status, 403);
        });
    });

    await t.test("namespace admits an outside create and exact-picks it", async () => {
        process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = "namespace";
        await withWorkspace(async ({ outside, file, db, workspaceId, ctx }) => {
            const key = `../${basename(outside)}/outside.md`;
            await acceptCreate(file, ctx, key, "outside\n");
            assert.equal(await readFile(join(outside, "outside.md"), "utf8"), "outside\n");
            assert.deepEqual(await constraints(db, workspaceId), [
                { effect: "include", glob: key, source: "create" },
            ]);
        });
    });
});

test("{§file-create-scope}: an in-root symlinked parent cannot bypass the root ceiling", async () => {
    await withWorkspace(async ({ root, outside, file, ctx }) => {
        await symlink(outside, join(root, "escape"), "dir");
        const result = await file.edit(edit("escape/smuggled.md", "outside\n"), ctx);
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-outside-workspace");
        await assert.rejects(stat(join(outside, "smuggled.md")));
    });
});

test("{§file-create-transaction}: approval rejects a parent symlink swapped after proposal", async () => {
    await withWorkspace(async ({ root, outside, file, db, workspaceId, ctx }) => {
        const parent = join(root, "pending");
        await mkdir(parent);
        const proposed = await file.edit(edit("pending/escaped.md", "outside\n"), ctx);
        assert.equal(proposed.status, 202);

        await rm(parent, { recursive: true });
        await symlink(outside, parent, "dir");
        const applied = await file.applyResolution({ attrs: proposed.attrs as never }, ctx);

        assert.equal(applied.status, 403);
        assert.equal(applied.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-outside-workspace");
        await assert.rejects(stat(join(outside, "escaped.md")));
        assert.deepEqual(await constraints(db, workspaceId), []);
    });
});

test("{§fs-create-kill}: generated picks follow deletion while explicit picks survive it", async () => {
    await withWorkspace(async ({ file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "generated.md");
        const generatedDelete = await file.deleteEntry("generated.md", ctx);
        assert.equal(generatedDelete.status, 202);
        assert.equal((await file.applyResolution({ attrs: generatedDelete.attrs as never }, ctx)).status, 200);
        assert.deepEqual(await constraints(db, workspaceId), [], "KILL removes creation provenance with its file");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "explicit.md", source: "members" });
        await acceptCreate(file, ctx, "explicit.md");
        const explicitDelete = await file.deleteEntry("explicit.md", ctx);
        assert.equal(explicitDelete.status, 202);
        assert.equal((await file.applyResolution({ attrs: explicitDelete.attrs as never }, ctx)).status, 200);
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "explicit.md", source: "members" },
        ], "automatic lifecycle never retracts a projected definition");
    });
});

test("{§fs-create-definition-overlap}: a member definition over a created path never overwrites the creation record", async () => {
    await withWorkspace(async ({ file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "promoted.md");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "promoted.md", source: "members" });
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "promoted.md", source: "create" },
        ], "the creation record stays as it is");
        const deletion = await file.deleteEntry("promoted.md", ctx);
        assert.equal(deletion.status, 202);
        assert.equal((await file.applyResolution({ attrs: deletion.attrs as never }, ctx)).status, 200);
        assert.deepEqual(await constraints(db, workspaceId), [], "deleting the file retires its record; the definition still lives in the members family");
    });
});

test("{§fs-create-masked}: exclusions mask creation records without consuming their provenance", async (t) => {
    await t.test("removing the exclusion restores the created member", async () => {
        await withWorkspace(async ({ file, db, workspaceId, ctx }) => {
            await acceptCreate(file, ctx, "masked.md");
            await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "masked.md", source: "members" });
            await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
            const hidden = await db.test_get_origin.get({ workspace_id: workspaceId, pathname: "masked.md" });
            assert.equal(hidden, undefined, "an exclusion removes the addressable entry");
            assert.deepEqual(await constraints(db, workspaceId), [
                { effect: "exclude", glob: "masked.md", source: "members" },
                { effect: "include", glob: "masked.md", source: "create" },
            ], "an exclusion masks rather than retracts creation provenance");

            await db.crud_delete_family_workspace_constraints.run({ workspace_id: workspaceId });
            await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
            const restored = await db.test_get_origin.get<{ membership_origin: string | null }>({
                workspace_id: workspaceId,
                pathname: "masked.md",
            });
            assert.equal(restored?.membership_origin, "constraint");
        });
    });

    await t.test("a later Git-ignore rule is likewise reversible", async () => {
        await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
            await acceptCreate(file, ctx, "ignored-later.md");
            await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
            await writeFile(join(root, ".gitignore"), "ignored-later.md\n");
            assert.deepEqual(
                await GitMembership.indexGitMembership(ctx),
                [],
                "a policy mask is not narrated as an ambient file deletion",
            );
            const hidden = await db.test_get_origin.get({ workspace_id: workspaceId, pathname: "ignored-later.md" });
            assert.equal(hidden, undefined);
            assert.deepEqual((await constraints(db, workspaceId)).filter(({ source }) => source === "create"), [
                { effect: "include", glob: "ignored-later.md", source: "create" },
            ]);

            await writeFile(join(root, ".gitignore"), "");
            await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
            const restored = await db.test_get_origin.get<{ membership_origin: string | null }>({
                workspace_id: workspaceId,
                pathname: "ignored-later.md",
            });
            assert.equal(restored?.membership_origin, "constraint");
        });
    });
});

test("{§fs-create-ambient-delete}: reconciliation removes stale generated provenance with an ambient deletion", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "ambient.md");
        await rm(join(root, "ambient.md"));
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.deepEqual(await constraints(db, workspaceId), []);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "ambient.md",
        });
        assert.equal(member, undefined);
    });
});

test("{§fs-create-incorporation}: generated exact picks preserve literal glob metacharacters", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        const pathname = "literal[1]*?.md";
        await acceptCreate(file, ctx, pathname);
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.equal(await readFile(join(root, pathname), "utf8"), "created\n");
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: pathname, source: "create" },
        ]);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname,
        });
        assert.equal(member?.membership_origin, "constraint");
    });
});

test("{§file-create-transaction}: failed incorporation rolls disk and entry state back together", async (t) => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        t.mock.method(console, "error", () => {});
        t.mock.method(db.crud_insert_generated_workspace_constraint, "run", async () => {
            throw new Error("injected constraint persistence failure");
        });
        const proposed = await file.edit(edit("rollback.md", "transient\n"), ctx);
        assert.equal(proposed.status, 202);
        const applied = await file.applyResolution({ attrs: proposed.attrs as never }, ctx);
        assert.equal(applied.status, 500);
        assert.equal(applied.problem?.type, "https://problems.plurnk.xyz/scheme/file/creation-incorporation-failed");
        await assert.rejects(stat(join(root, "rollback.md")));
        assert.deepEqual(await constraints(db, workspaceId), []);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "rollback.md",
        });
        assert.equal(member, undefined);
    });
});
