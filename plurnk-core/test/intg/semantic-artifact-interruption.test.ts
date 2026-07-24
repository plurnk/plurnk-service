import test from "node:test";
import assert from "node:assert/strict";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const target: UrlPath = {
    kind: "url", raw: "worker:///interrupted.md", scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: "/interrupted.md", params: {}, fragment: null,
};
const statement: EditStatement = {
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null,
    body: "an interrupted derivation must never attach", position: { line: 1, column: 1 },
};

test("an interrupted artifact stays building and unattached; retry completes and attaches (#588)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interrupt-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));

        const abort = new AbortController();
        let failOnce = true;
        const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
        const mimetypes = {
            process: async (input: { content: string }) => ({ content: input.content, embedding: vector, embeddingModel: "stub@interrupt" }),
            embedderInfo: () => ({ contextWindow: 128, countTokens: (text: string) => text.split(/\s+/u).filter(Boolean).length, model: "stub@interrupt" }),
            embedBatch: async (texts: readonly string[]) => {
                if (failOnce) {
                    failOnce = false;
                    abort.abort();
                    throw new DOMException("interrupted", "AbortError");
                }
                return texts.map(() => vector);
            },
        } as unknown as Mimetypes;

        await assert.rejects(
            EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes, signal: abort.signal })),
            /interrupted/,
        );
        const interrupted = await (db.test_derivation_interruption_state as PrepMethod).get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.deepEqual(interrupted, { deep_hash: null, building: 1, complete: 0 }, "no partial artifact becomes visible through the entry");

        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const recovered = await (db.test_derivation_interruption_state as PrepMethod).get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.ok(recovered?.deep_hash);
        assert.deepEqual({ building: recovered?.building, complete: recovered?.complete }, { building: 0, complete: 1 }, "retry completes the same artifact and only then attaches it");
    } finally {
        await db.close();
    }
});

test("an entry-local derivation failure is terminal, explicit, and does not block readiness", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `failed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await new Worker().edit(statement, makeSchemeCtx({ db, workspaceId, workerId }));

        const mimetypes = {
            process: async () => { throw new Error("fixture reader exploded"); },
            embedderInfo: () => ({ contextWindow: 128, countTokens: async () => 1, model: "stub@failure" }),
        } as unknown as Mimetypes;

        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const entry = await (db.test_entries_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "/interrupted.md" });
        const disposition = await (db.test_derivation_disposition as PrepMethod).get<{ disposition: string; reason: string }>({ entry_id: entry?.id ?? -1 });
        assert.equal(disposition?.disposition, "failed");
        assert.equal(disposition?.reason, "fixture reader exploded");
        const state = await (db.test_derivation_interruption_state as PrepMethod).get<{ deep_hash: string | null; building: number; complete: number }>({ workspace_id: workspaceId });
        assert.ok(state?.deep_hash, "the terminal failure attaches an explicit artifact");
        assert.deepEqual({ building: state?.building, complete: state?.complete }, { building: 0, complete: 1 });
    } finally {
        await db.close();
    }
});
