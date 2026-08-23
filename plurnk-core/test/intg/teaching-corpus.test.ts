// {§teaching-corpus} — required first-party teaching fails at the real
// package-resolution/materialization boundary; manifest-owned depth is the optional case.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { teachingCorpusReader } from "../../src/core/teaching-corpus.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { DEFAULT_MIMETYPES, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const corpusRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-teaching-"));
    await mkdir(join(root, "docs"));
    return root;
};

test("required built-in corpus absence rejects workspace doc materialization with its filesystem cause", async () => {
    const root = await corpusRoot();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry({ readTeaching: teachingCorpusReader(root) });
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `teaching-absent-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);

        await assert.rejects(
            () => LoopDocs.materialize(engine, db, workspaceId, workerId),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /required teaching source 'docs\/worker\.md' could not be read/);
                assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
                return true;
            },
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed required corpus read is not reclassified as optional absence", async () => {
    const root = await corpusRoot();
    const db = await openMigrated();
    try {
        await mkdir(join(root, TEACHING_CORPUS.schemeDocs.worker));
        const schemes = new SchemeRegistry({ readTeaching: teachingCorpusReader(root) });
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `teaching-unreadable-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);

        await assert.rejects(
            () => LoopDocs.materialize(engine, db, workspaceId, workerId),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /required teaching source 'docs\/worker\.md' could not be read/);
                assert.ok(error.cause instanceof Error, "the underlying read failure is preserved as cause");
                return true;
            },
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
