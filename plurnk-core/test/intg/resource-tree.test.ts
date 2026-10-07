import assert from "node:assert/strict";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import { GeneratedByteSource, Results, type ResourceTree, type ResourceTreeRegistrationSeam, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorker, openMigrated } from "./_db.ts";
import { copyStmt, editStmt, findStmt, killStmt, readStmt, regex } from "./_dsl.ts";

test("{§resource-tree-scheme} a public module supplies live trees while the host owns projection, selection and withdrawal", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const files = new Map<string, string | Uint8Array>([
        ["guide.txt", "one\nneedle\nthree"],
        ["nested/child.txt", "nested source"],
        ["bytes.txt", Buffer.from([0, 255, 128])],
    ]);
    const trees = new Map<string, ResourceTree>([["alpha", {
        list: async () => [...files.keys()],
        resource: (name) => new GeneratedByteSource(async () => {
            const value = files.get(name);
            return typeof value === "string" ? new TextEncoder().encode(value) : value ?? null;
        }),
    }], ["beta", {
        list: async () => ["guide.txt"],
        resource: (name) => new GeneratedByteSource(async () => name === "guide.txt" ? new TextEncoder().encode("other tree") : null),
    }]]);
    daemon.registerModule({ async setup(seam: ResourceTreeRegistrationSeam) {
        await seam.registerResourceTreeScheme("catalog", { trees: () => trees });
    } }, "@acme/catalog");
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "resource-tree-witness" });
    const workerId = await insertWorker(db, workspaceId, null, "reader", "client");
    const dispatch = (statement: PlurnkStatement) => daemon.dispatchAsClient({ workspaceId, workerId, statement });
    const find = async (path: string, matcher: ReturnType<typeof regex> | null = null) => {
        const result = await dispatch({ ...findStmt(parsePath(path), matcher), lineMarker: { marks: [1, -1] } });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.ok(Array.isArray(result.results));
        return (result.results.flat() as Array<{ path: string }>).map(({ path }) => path);
    };
    assert.deepEqual(await find("catalog://*/guide.txt", regex("needle")), ["catalog://alpha/guide.txt"]);
    assert.deepEqual(await find("catalog://alpha/*"), ["catalog://alpha/bytes.txt", "catalog://alpha/guide.txt", "catalog://alpha/nested/**"]);
    const guide = parsePath("catalog://alpha/guide.txt");
    assert.equal((await dispatch(readStmt(guide, { marks: [2, 2] }))).content, "needle");
    const binary = await dispatch(readStmt(parsePath("catalog://alpha/bytes.txt"), { marks: [1, -1] }));
    assert.equal(binary.status, 200);
    assert.equal(binary.content, "00\nff\n80", "binary sniffing and byte projection belong to the host");
    const copied = await dispatch(copyStmt(guide!, parsePath("worker:///copied.txt")!, { marks: [2, 2] }));
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal((await dispatch(readStmt(parsePath("worker:///copied.txt")))).content, "needle\n", "COPY preserves the selected source line's terminator");
    for (const statement of [editStmt(guide, "changed", { marks: [1, -1] }), killStmt(guide)]) {
        assert.equal((await dispatch(statement)).status, 403, "tree projections cannot mutate their sources");
    }
    files.set("guide.txt", "fresh text");
    assert.equal((await dispatch(readStmt(guide))).content, "fresh text");
    files.delete("guide.txt");
    assert.equal((await dispatch(readStmt(guide))).status, 404, "cached content is not a missing source");
    trees.delete("beta");
    assert.deepEqual(await find("catalog://*/**"), ["catalog://alpha/bytes.txt", "catalog://alpha/nested/child.txt"]);
});

test("{§resource-tree-scheme} projection failures cannot become source refusals or stale content", async (t) => {
    const db = await openMigrated();
    const mimetypes = new Mimetypes();
    const daemon = new Daemon({ db, provider: null, mimetypes });
    t.after(async () => { await daemon.stop(); await mimetypes.dispose(); await db.close(); });
    let translations = 0;
    daemon.registerModule({ async setup(seam: ResourceTreeRegistrationSeam) {
        await seam.registerResourceTreeScheme("catalog", {
            trees: () => new Map([["alpha", {
                list: async () => ["image.png"],
                resource: () => new GeneratedByteSource(async () => Buffer.from([0, 1, 2])),
            }]]),
            refusal: () => {
                translations++;
                return Results.failure("scheme:catalog", "entry-not-found", 404, "Missing source.");
            },
        });
    } }, "@acme/catalog");
    await daemon.start();
    t.mock.method(mimetypes, "projectReadableStream", async () => { throw Object.assign(new Error("projection failed"), { code: "ENOENT" }); });
    const { workspaceId } = await daemon.createWorkspace({ name: "resource-tree-projection" });
    const workerId = await insertWorker(db, workspaceId, null, "reader", "client");
    for (const statement of [readStmt(parsePath("catalog://alpha/image.png")), findStmt(parsePath("catalog://alpha/**"))]) {
        const result: SchemeResult = await daemon.dispatchAsClient({ workspaceId, workerId, statement });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw");
    }
    assert.equal(translations, 0, "the source does not classify another owner's errors");
});

test("{§resource-tree-scheme} recognized source failures retain their result through exact and collection reads", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const failure = new Error("source refused");
    daemon.registerModule({ async setup(seam: ResourceTreeRegistrationSeam) {
        await seam.registerResourceTreeScheme("catalog", {
            trees: () => new Map([["refused", {
                list: async () => { throw failure; },
                resource: () => new GeneratedByteSource(async () => { throw failure; }),
            }]]),
            refusal: (cause) => cause === failure
                ? Results.failure("scheme:catalog", "resource-outside-root", 403, "The source is outside its tree.")
                : null,
        });
    } }, "@acme/catalog");
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "resource-tree-failure" });
    const workerId = await insertWorker(db, workspaceId, null, "reader", "client");
    for (const statement of [readStmt(parsePath("catalog://refused/item")), findStmt(parsePath("catalog://refused/**"))]) {
        const result: SchemeResult = Results.assert(await daemon.dispatchAsClient({ workspaceId, workerId, statement }));
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/catalog/resource-outside-root");
        assert.equal(result.problem.detail, "The source is outside its tree.");
    }
});
