import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import File from "../../src/schemes/File.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import DbProjectionCaps from "../../src/core/caps/DbProjectionCaps.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import GitMembership from "../../src/core/git-membership.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import FileSnapshot from "../../src/core/FileSnapshot.ts";
import FilePublication from "../../src/core/FilePublication.ts";
import { openMigrated, insertWorkspace, rootWorkspace, insertWorker, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, mimetypesFixture, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { ownWorker } from "./_approval.ts";
import { editStmt, copyStmt, moveStmt, readStmt, localPath, fullReplace } from "./_dsl.ts";

const original = "old content\n";
const external = "new content\n";

const fixture = async (t: TestContext) => {
    const root = await fs.mkdtemp(join(tmpdir(), "plurnk-file-integrity-"));
    const db = await openMigrated(join(root, "plurnk.db"));
    t.after(async () => {
        await db.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    const workspaceId = await insertWorkspace(db, "integrity");
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId);
    await ownWorker(db, workspaceId, workerId);
    const loopId = await insertLoop(db, workerId, 1, "integrity");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const ids = { workspaceId, workerId, loopId, turnId };
    const ctx = makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES });
    const file = new File();
    const path = join(root, "doc.md");
    const creating = await file.edit(editStmt(localPath("doc.md"), original), ctx);
    assert.equal(creating.status, 202);
    assert.equal((await file.applyResolution({ attrs: creating.attrs as never }, ctx)).status, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: ctx.weigh });
    return { root, db, ids, ctx, file, path, engine };
};

for (const scope of ["workers", "workspaces", "aliases"] as const) {
    test(`{§file-commit-serialization}: competing ${scope} cannot both overwrite one baseline`, async (t) => {
        const fx = await fixture(t);
        const workspaceId = scope !== "workspaces" ? fx.ids.workspaceId : await insertWorkspace(fx.db, "second");
        const pathname = scope === "aliases" ? "alias.md" : "doc.md";
        if (scope === "aliases") {
            await fs.symlink("doc.md", join(fx.root, pathname));
            await fx.db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname, membership_origin: "constraint" });
        }
        if (scope === "workspaces") {
            await rootWorkspace(fx.db, workspaceId, fx.root);
            await fx.db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "doc.md", membership_origin: "constraint" });
        }
        const workerId = await insertWorker(fx.db, workspaceId);
        const secondCtx = makeSchemeCtx({ ...fx.ctx, workspaceId, workerId });
        await MembershipMaterialization.materializeMember(pathname, fx.root, secondCtx, new Map());
        const first = await fx.file.edit(editStmt(localPath("doc.md"), "first edit!\n", fullReplace), fx.ctx);
        const second = await fx.file.edit(editStmt(localPath(pathname), "second edit\n", fullReplace), secondCtx);
        assert.equal(first.status, 202);
        assert.equal(second.status, 202);
        const barrier = Promise.withResolvers<void>();
        let arrivals = 0;
        const parse = DbProjectionCaps.prototype.parseIssueTransition;
        t.mock.method(DbProjectionCaps.prototype, "parseIssueTransition", async function (this: DbProjectionCaps, ...args: Parameters<typeof parse>) {
            if (++arrivals === 2) barrier.resolve();
            await barrier.promise;
            return parse.apply(this, args);
        });
        const results = await Promise.all([
            fx.file.applyResolution({ attrs: first.attrs as never }, fx.ctx),
            fx.file.applyResolution({ attrs: second.attrs as never }, secondCtx),
        ]);
        assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
        const winner = results[0].status === 200 ? "first edit!\n" : "second edit\n";
        assert.equal(await fs.readFile(fx.path, "utf8"), winner);
        const rejected = results.find(({ status }) => status === 409);
        assert.match(rejected?.problem?.type ?? "", /edit-collision$/);
    });
}

test("{§file-snapshot-revision}: source revisions stay internal to ordinary READ receipts", async (t) => {
    const fx = await fixture(t);
    const result = await fx.engine.look({ ...fx.ids, statement: readStmt(localPath("doc.md")) });
    assert.equal(result.status, 200);
    assert.match(String((result as { content?: unknown }).content), /old content/);
    assert.doesNotMatch(JSON.stringify(result), /fileRevision|synced_sig|fingerprint/);
});

test("{§membership-change-gated-sync}: deletion of an unversioned projection preserves its divergence evidence", async (t) => {
    const fx = await fixture(t);
    await EntryCrud.writeEntry({ authority: "", pathname: "doc.md" }, {
        channels: { body: { content: original, mimetype: "text/markdown" } },
    }, fx.ctx, "file");
    await fs.unlink(fx.path);
    const divergence = await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal(divergence?.before, original);
    assert.equal(divergence?.after, "");
    assert.deepEqual((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels, {});
    assert.equal(await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map()), null);
});

for (const mutation of ["EDIT", "KILL"] as const) {
    for (const drift of ["same-size-and-mtime", "replacement", "missing", "directory"] as const) {
        test(`{§membership-edit-write-revision} {§file-delete-revision}: ${mutation} preserves ${drift} drift`, async (t) => {
            const fx = await fixture(t);
            await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
            await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
            const proposal = mutation === "EDIT"
                ? await fx.file.edit(editStmt(localPath("doc.md"), "proposed\n", fullReplace), fx.ctx)
                : await fx.file.deleteEntry("doc.md", fx.ctx);
            assert.equal(proposal.status, 202);
            if (drift === "missing") await fs.unlink(fx.path);
            else if (drift === "directory") {
                await fs.unlink(fx.path);
                await fs.mkdir(fx.path);
            }
            else if (drift === "replacement") {
                const other = join(fx.root, "other.md");
                await fs.writeFile(other, external);
                await fs.rename(other, fx.path);
            } else {
                await fs.writeFile(fx.path, external);
                await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
            }
            const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
            assert.equal(result.status, 409);
            assert.match(result.problem?.type ?? "", /edit-collision$/);
            if (drift === "missing") await assert.rejects(fs.stat(fx.path), { code: "ENOENT" });
            else if (drift === "directory") assert.equal((await fs.stat(fx.path)).isDirectory(), true);
            else assert.equal(await fs.readFile(fx.path, "utf8"), external);
        });
    }
}

test("{§file-delete-revision}: reviewed MOVE retains the selected source revision and reports its written destination", async (t) => {
    const fx = await fixture(t);
    const pending = Promise.withResolvers<number>();
    fx.engine.onProposalPending((event) => pending.resolve(event.logEntryId));
    const moving = fx.engine.dispatch({ ...fx.ids,
        statement: moveStmt(localPath("doc.md"), localPath("destination.md")),
        sequence: 1, origin: "model",
    });
    const logEntryId = await Promise.race([pending.promise, moving.then((result) => assert.fail(`Expected review: ${JSON.stringify(result)}`))]);
    await fs.writeFile(fx.path, external);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    fx.engine.resolveProposal(logEntryId, { decision: "accept" });
    const result = await moving;
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(await fs.readFile(fx.path, "utf8"), external);
    assert.equal(await fs.readFile(join(fx.root, "destination.md"), "utf8"), original);
    assert.deepEqual(result.effects, [{ target: "destination.md", action: "create" }]);
    assert.equal(result.problem?.destinationWritten, true);
});

test("{§membership-change-gated-sync}: same-size content with restored mtime is rematerialized", async (t) => {
    const fx = await fixture(t);
    await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    await fs.writeFile(fx.path, external);
    await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
    const divergence = await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal(divergence?.before, original);
    assert.equal(divergence?.after, external);
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, external);
});

test("{§file-snapshot-revision}: an external update after projection publication is not restamped as our write", async (t) => {
    const fx = await fixture(t);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    const proposed = "replacement from model\n";
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), proposed, fullReplace), fx.ctx);
    assert.equal(proposal.status, 202);
    const publish = EntryCrud.writeEntry;
    t.mock.method(EntryCrud, "writeEntry", async (...args: Parameters<typeof publish>) => {
        const result = await publish(...args);
        if (args[0].pathname === "doc.md" && args[3] === "file") await fs.writeFile(fx.path, external);
        return result;
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 200);
    t.mock.restoreAll();
    const divergence = await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal(divergence?.before, proposed);
    assert.equal(divergence?.after, external);
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, external);
});

test("{§file-delete-revision}: creation rollback preserves another writer's replacement", async (t) => {
    const fx = await fixture(t);
    const target = join(fx.root, "new.md");
    const replacement = join(fx.root, "external.md");
    const proposal = await fx.file.edit(editStmt(localPath("new.md"), original), fx.ctx);
    assert.equal(proposal.status, 202);
    t.mock.method(GitMembership, "incorporateCreation", async () => {
        await fs.writeFile(replacement, external);
        await fs.rename(replacement, target);
        throw new Error("fixture: incorporation failed after external replacement");
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 500);
    assert.match(result.problem?.type ?? "", /creation-rollback-failed$/);
    assert.equal(await fs.readFile(target, "utf8"), external);
});

for (const existing of [true, false]) {
    test(`{§file-publication}: a partial stage write preserves ${existing ? "the original" : "absence"}`, async (t) => {
        const fx = await fixture(t);
        const pathname = existing ? "doc.md" : "new.md";
        const proposal = await fx.file.edit(editStmt(localPath(pathname), "replacement\n", existing ? fullReplace : null), fx.ctx);
        assert.equal(proposal.status, 202);
        const open = fs.open;
        t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (args[1] === "wx") {
                const write = handle.writeFile.bind(handle);
                t.mock.method(handle, "writeFile", async () => {
                    await write("partial");
                    throw Object.assign(new Error("fixture: disk full"), { code: "ENOSPC" });
                });
            }
            return handle;
        });
        const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
        assert.equal(result.status, 500);
        assert.match(result.problem?.type ?? "", /write-failed$/);
        assert.equal(result.problem?.published, false);
        if (existing) assert.equal(await fs.readFile(fx.path, "utf8"), original);
        else await assert.rejects(fs.stat(join(fx.root, pathname)), { code: "ENOENT" });
        assert.deepEqual((await fs.readdir(fx.root)).filter((name) => name.startsWith(".plurnk-write-")), []);
    });
}

test("{§membership-edit-write-revision}: final validation follows staging and fallible receipt preparation", async (t) => {
    const fx = await fixture(t);
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), "replacement\n", fullReplace), fx.ctx);
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") {
            const sync = handle.sync.bind(handle);
            t.mock.method(handle, "sync", async () => {
                await sync();
                await fs.writeFile(fx.path, external);
            });
        }
        return handle;
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 409);
    assert.match(result.problem?.type ?? "", /edit-collision$/);
    assert.equal(await fs.readFile(fx.path, "utf8"), external);
});

test("{§file-create-no-clobber}: an occupant appearing at publication is preserved", async (t) => {
    const fx = await fixture(t);
    const target = join(fx.root, "new.md");
    const proposal = await fx.file.edit(editStmt(localPath("new.md"), original), fx.ctx);
    const link = fs.link;
    t.mock.method(fs, "link", async (...args: Parameters<typeof link>) => {
        await fs.writeFile(target, external);
        return link(...args);
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 409);
    assert.equal(await fs.readFile(target, "utf8"), external);
});

test("{§file-external-race}: creation revalidates a symlinked parent after staging", async (t) => {
    const fx = await fixture(t);
    await fs.mkdir(join(fx.root, "first"));
    await fs.mkdir(join(fx.root, "second"));
    const alias = join(fx.root, "alias");
    await fs.symlink("first", alias);
    const proposal = await fx.file.edit(editStmt(localPath("alias/new.md"), original), fx.ctx);
    assert.equal(proposal.status, 202);
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") {
            const sync = handle.sync.bind(handle);
            t.mock.method(handle, "sync", async () => {
                await sync();
                await fs.unlink(alias);
                await fs.symlink("second", alias);
            });
        }
        return handle;
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 409);
    assert.match(result.problem?.type ?? "", /edit-collision$/);
    for (const parent of ["first", "second"]) {
        await assert.rejects(fs.stat(join(fx.root, parent, "new.md")), { code: "ENOENT" });
    }
});

test("{§file-publication}: replacement preserves mode and owner while hard links and open descriptors retain old bytes", async (t) => {
    const fx = await fixture(t);
    const other = join(fx.root, "linked.md");
    await fs.chmod(fx.path, 0o751);
    await fs.link(fx.path, other);
    const handle = await fs.open(fx.path, "r");
    t.after(() => handle.close());
    const before = await fs.stat(fx.path);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), "replacement\n", fullReplace), fx.ctx);
    assert.equal((await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx)).status, 200);
    const after = await fs.stat(fx.path);
    assert.equal(after.mode, before.mode);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.notEqual(after.ino, before.ino);
    assert.equal(await fs.readFile(fx.path, "utf8"), "replacement\n");
    assert.equal(await fs.readFile(other, "utf8"), original);
    assert.equal(await handle.readFile("utf8"), original);
});

for (const binary of [false, true]) {
    for (const scoped of [false, true]) {
        test(`{§file-delete-revision}: ${binary ? "binary" : "text"} ${scoped ? "scoped" : "whole"} MOVE preserves source drift through review`, async (t) => {
            const fx = await fixture(t);
            const source = binary ? "source.png" : "doc.md";
            const initial = binary ? Buffer.from([0, 1, 2, 3]) : Buffer.from("one\ntwo\nthree\n");
            const changed = binary ? Buffer.from([0, 9, 8, 7]) : Buffer.from("new\ntwo\nthree\n");
            await fs.writeFile(join(fx.root, source), initial);
            if (binary) await fx.db.crud_register_workspace_member.get({ workspace_id: fx.ids.workspaceId, scheme: "file", authority: "", pathname: source, membership_origin: "constraint" });
            await MembershipMaterialization.materializeMember(source, fx.root, fx.ctx, new Map());
            const pending = Promise.withResolvers<number>();
            fx.engine.onProposalPending((event) => pending.resolve(event.logEntryId));
            const destination = binary ? "destination.png" : "destination.md";
            const moving = fx.engine.dispatch({ ...fx.ids,
                statement: moveStmt(localPath(source), localPath(destination), scoped ? { marks: [2, 2] } : null),
                sequence: 1, origin: "model",
            });
            const logEntryId = await Promise.race([pending.promise, moving.then((result) => assert.fail(`Expected review: ${JSON.stringify(result)}`))]);
            await fs.writeFile(join(fx.root, source), changed);
            await MembershipMaterialization.materializeMember(source, fx.root, fx.ctx, new Map());
            fx.engine.resolveProposal(logEntryId, { decision: "accept" });
            const result = await moving;
            assert.equal(result.status, 409, JSON.stringify(result));
            assert.equal(result.problem?.destinationWritten, true);
            assert.ok(Array.isArray(result.effects));
            assert.equal(result.effects.length, 1);
            assert.partialDeepStrictEqual(result.effects, [{ target: destination, action: "create" }]);
            assert.deepEqual(await fs.readFile(join(fx.root, source)), changed);
            assert.deepEqual(await fs.readFile(join(fx.root, destination)), scoped
                ? binary ? Buffer.from([1]) : Buffer.from("two\n") : initial);
        });
    }
}

test("{§membership-edit-write-revision}: a scoped binary COPY does not rebase its destination during approval", async (t) => {
    const fx = await fixture(t);
    for (const [pathname, bytes] of [["source.bin", Buffer.from([0, 1])], ["target.bin", Buffer.from([0, 3, 4])]] as const) {
        await fs.writeFile(join(fx.root, pathname), bytes);
        await fx.db.crud_register_workspace_member.get({ workspace_id: fx.ids.workspaceId, scheme: "file", authority: "", pathname, membership_origin: "constraint" });
        await MembershipMaterialization.materializeMember(pathname, fx.root, fx.ctx, new Map());
    }
    const pending = Promise.withResolvers<number>();
    fx.engine.onProposalPending((event) => pending.resolve(event.logEntryId));
    const copying = fx.engine.dispatch({ ...fx.ids,
        statement: copyStmt(localPath("source.bin"), localPath("target.bin"), null, { marks: [2, 2] }),
        sequence: 1, origin: "model",
    });
    const logEntryId = await Promise.race([pending.promise, copying.then((result) => assert.fail(`Expected review: ${JSON.stringify(result)}`))]);
    const changed = Buffer.from([0, 8, 9]);
    await fs.writeFile(join(fx.root, "target.bin"), changed);
    await MembershipMaterialization.materializeMember("target.bin", fx.root, fx.ctx, new Map());
    fx.engine.resolveProposal(logEntryId, { decision: "accept" });
    const result = await copying;
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.match(result.problem?.type ?? "", /edit-collision$/);
    assert.deepEqual(await fs.readFile(join(fx.root, "target.bin")), changed);
    assert.deepEqual(await fs.readFile(join(fx.root, "source.bin")), Buffer.from([0, 1]));
});

for (const changed of [false, true]) {
    test(`{§file-delete-revision}: oversized-file deletion ${changed ? "rejects content drift with identical metadata" : "accepts an unchanged captured revision"}`, async (t) => {
        const fx = await fixture(t);
        const previous = process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES;
        process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "1";
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES;
            else process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = previous;
        });
        // Simulate a filesystem whose stat clock cannot distinguish these same-length writes.
        const fingerprint = (await FileSnapshot.observe(fx.path))!.fingerprint;
        t.mock.method(FileSnapshot, "fingerprint", () => fingerprint);
        await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
        const proposal = await fx.file.deleteEntry("doc.md", fx.ctx);
        assert.equal(proposal.status, 202);
        if (changed) await fs.writeFile(fx.path, external);
        const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
        if (changed) {
            assert.equal(result.status, 409);
            assert.match(result.problem?.type ?? "", /edit-collision$/);
            assert.equal(await fs.readFile(fx.path, "utf8"), external);
        } else {
            assert.equal(result.status, 200);
            await assert.rejects(fs.stat(fx.path), { code: "ENOENT" });
        }
    });
}

test("{§file-publication}: database failure after replacement reports the effect and reconciliation recovers it", async (t) => {
    const fx = await fixture(t);
    const proposed = "landed on disk\n";
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), proposed, fullReplace), fx.ctx);
    t.mock.method(EntryCrud, "writeEntry", async () => { throw new Error("fixture: database publication failed"); });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 500);
    assert.match(result.problem?.type ?? "", /materialization-failed$/);
    assert.deepEqual(result.effects, [{ target: "doc.md", action: "update" }]);
    assert.equal(await fs.readFile(fx.path, "utf8"), proposed);
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, original);
    t.mock.restoreAll();
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, proposed);
});

test("{§file-snapshot-revision}: a failed channel publication rolls back its source revision too", async (t) => {
    const fx = await fixture(t);
    const before = await fx.file.readEntry("doc.md", fx.ctx);
    await assert.rejects(EntryCrud.writeEntry({ authority: "", pathname: "doc.md" }, {
        channels: { body: { content: "rejected", mimetype: "text/markdown", state: "invalid" as never } },
    }, fx.ctx, "file", { syncedSig: "rejected-revision" }), /CHECK constraint failed: state IN/);
    assert.deepEqual(await fx.file.readEntry("doc.md", fx.ctx), before);
});

for (const retargeted of [false, true]) {
    test(`{§file-external-race}: an in-project symlink ${retargeted ? "cannot redirect a pending edit" : "retains its link after editing the target"}`, async (t) => {
        const fx = await fixture(t);
        const alias = join(fx.root, "alias.md");
        await fs.symlink("doc.md", alias);
        await fx.db.crud_register_workspace_member.get({ workspace_id: fx.ids.workspaceId, scheme: "file", authority: "", pathname: "alias.md", membership_origin: "constraint" });
        await MembershipMaterialization.materializeMember("alias.md", fx.root, fx.ctx, new Map());
        const proposal = await fx.file.edit(editStmt(localPath("alias.md"), "replacement\n", fullReplace), fx.ctx);
        assert.equal(proposal.status, 202);
        if (retargeted) {
            await fs.writeFile(join(fx.root, "other.md"), external);
            await fs.unlink(alias);
            await fs.symlink("other.md", alias);
        }
        const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
        assert.equal(result.status, retargeted ? 409 : 200);
        assert.equal(await fs.readFile(fx.path, "utf8"), retargeted ? original : "replacement\n");
        assert.equal(await fs.readlink(alias), retargeted ? "other.md" : "doc.md");
        if (retargeted) assert.equal(await fs.readFile(join(fx.root, "other.md"), "utf8"), external);
    });
}

test("{§file-commit-serialization}: reconciliation settles before a same-file commit while another file progresses", async (t) => {
    const fx = await fixture(t);
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), "replacement\n", fullReplace), fx.ctx);
    const independent = await fx.file.edit(editStmt(localPath("independent.md"), "independent\n"), fx.ctx);
    // Invalidate the projection, requiring a real materialization publication.
    await EntryCrud.writeEntry({ authority: "", pathname: "doc.md" }, {
        channels: { body: { content: original, mimetype: "text/markdown" } },
    }, fx.ctx, "file");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let materializing = false;
    const publish = EntryCrud.writeEntry;
    t.mock.method(EntryCrud, "writeEntry", async (...args: Parameters<typeof publish>) => {
        if (args[0].pathname !== "doc.md" || args[1].channels.body?.content !== original) return publish(...args);
        materializing = true;
        started.resolve();
        try {
            await release.promise;
            return await publish(...args);
        } finally { materializing = false; }
    });
    const write = FilePublication.write;
    t.mock.method(FilePublication, "write", async (...args: Parameters<typeof write>) => {
        if (args[1] === fx.path) assert.equal(materializing, false, "file publication cannot overtake an acquired source projection");
        return write(...args);
    });
    const reconciling = MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    await started.promise;
    const committing = Promise.allSettled([fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx)]);
    try {
        assert.equal((await fx.file.applyResolution({ attrs: independent.attrs as never }, fx.ctx)).status, 200);
        assert.equal(await fs.readFile(fx.path, "utf8"), original);
        assert.equal(await fs.readFile(join(fx.root, "independent.md"), "utf8"), "independent\n");
    } finally { release.resolve(); }
    await reconciling;
    const [settled] = await committing;
    assert.equal(settled!.status, "fulfilled");
    assert.equal(settled!.value.status, 200);
    assert.equal(await fs.readFile(fx.path, "utf8"), "replacement\n");
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, "replacement\n");
});

test("{§file-publication}: staging cleanup failure preserves the original write error and leaves the target intact", async (t) => {
    const fx = await fixture(t);
    const baseline = (await FileSnapshot.acquire(fx.path, null))!.revision;
    const failure = new Error("fixture: stage I/O failed");
    const cleanupFailure = new Error("fixture: directory cleanup failed");
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") t.mock.method(handle, "writeFile", async () => { throw failure; });
        return handle;
    });
    t.mock.method(fs, "rmdir", async () => { throw cleanupFailure; });
    const result = await FilePublication.write(fx.path, fx.path, baseline, Buffer.from("replacement\n"));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") assert.fail("Expected the failed publication");
    assert.equal(result.published, false);
    assert.ok(result.cause instanceof AggregateError);
    assert.deepEqual(result.cause.errors, [failure, cleanupFailure]);
    assert.equal(await fs.readFile(fx.path, "utf8"), original);
    t.mock.restoreAll();
});

test("{§file-publication}: a close failure preserves the original staging failure", async (t) => {
    const fx = await fixture(t);
    const baseline = (await FileSnapshot.acquire(fx.path, null))!.revision;
    const writeFailure = new Error("fixture: stage write failed");
    const closeFailure = new Error("fixture: close failed");
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") {
            t.mock.method(handle, "writeFile", async () => { throw writeFailure; });
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => { await close(); throw closeFailure; });
        }
        return handle;
    });
    const result = await FilePublication.write(fx.path, fx.path, baseline, Buffer.from("replacement\n"));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") assert.fail("Expected the failed publication");
    assert.equal(result.published, false);
    assert.ok(result.cause instanceof SuppressedError);
    assert.equal(result.cause.suppressed, writeFailure);
    assert.equal(result.cause.error, closeFailure);
    assert.equal(await fs.readFile(fx.path, "utf8"), original);
    assert.deepEqual((await fs.readdir(fx.root)).filter((name) => name.startsWith(".plurnk-write-")), []);
});

test("{§file-commit-serialization} {§membership-source-projection}: a slow projection never reserves its file and cannot publish over a newer edit", async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const fx = await fixture(t);
    const pathname = "image.png";
    const original = Buffer.from([0, 1, 2, 3]);
    const replacement = Buffer.from([0, 9, 8, 7]);
    const seed = await fx.file.writeEntry(pathname, {
        channels: { body: { content: "", bytes: original, mimetype: "image/png" } },
    }, fx.ctx);
    assert.equal((await fx.file.applyResolution({ attrs: seed.attrs as never }, fx.ctx)).status, 200);
    const proposal = await fx.file.writeEntry(pathname, {
        channels: { body: { content: "", bytes: replacement, mimetype: "image/png" } },
    }, fx.ctx);
    assert.equal(proposal.status, 202);
    const projecting = Promise.withResolvers<void>();
    const ctx = makeSchemeCtx({ ...fx.ctx, mimetypes: mimetypesFixture({
        projectReadable: async (input: { content: Uint8Array }) => {
            assert.deepEqual(input.content, original);
            projecting.resolve();
            await release.promise;
            return { content: "old derived body", sourceMimetype: "image/png", projectionIdentity: "fixture", facts: null };
        },
    }) });
    const materializing = MembershipMaterialization.materializeMember(pathname, fx.root, ctx, new Map());
    await projecting.promise;
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never }, fx.ctx);
    assert.equal(result.status, 200, "a file commit must progress while its old snapshot is being projected");
    assert.deepEqual(await fs.readFile(join(fx.root, pathname)), replacement);
    const committed = await fx.file.readEntry(pathname, fx.ctx);
    release.resolve();
    assert.equal(await materializing, null, "the stale derived body is discarded, not published");
    assert.deepEqual(await fx.file.readEntry(pathname, fx.ctx), committed);
});
