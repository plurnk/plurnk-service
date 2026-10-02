// {§teaching-corpus} — required first-party teaching fails at the real
// package-resolution/materialization boundary; manifest-owned depth is the optional case.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { teachingCorpusReader } from "../../src/core/teaching-corpus.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import Paths from "../../src/Paths.ts";
import { insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const corpusRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-teaching-"));
    await mkdir(join(root, "docs"));
    for (const [name, { source }] of Object.entries(TEACHING_CORPUS.docs)) {
        if (name === "worker") continue;
        await writeFile(join(root, source), await readFile(new URL(`../../../plurnk-meta/${source}`, import.meta.url)));
    }
    return root;
};

test("language and delegation references named by plurnk.md are materialized from their published sources", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `teaching-links-${crypto.randomUUID()}`);
        await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        for (const name of ["pattern", "delegation"] as const) {
            const body = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                pathname: `/_plurnk/plurnk/${name}.md`, scheme: "worker", name: "body",
            });
            assert.equal(body?.content, await readFile(Paths.teachingSource(TEACHING_CORPUS.docs[name].source), "utf8"));
        }
        const docs = await new SchemeRegistry().docs();
        assert.equal(docs.find(({ name }) => name === "pattern")?.scheme, null, "a language reference declares no new runtime scheme");
        assert.equal(docs.find(({ name }) => name === "delegation")?.scheme, "worker");
    } finally { await db.close(); }
});

test("required built-in corpus absence rejects workspace doc materialization with its filesystem cause", async () => {
    const root = await corpusRoot();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry({ readTeaching: teachingCorpusReader(root) });
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `teaching-absent-${crypto.randomUUID()}`);
        await insertWorker(db, workspaceId);

        await assert.rejects(
            () => LoopDocs.materialize(engine, db, workspaceId),
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
        await mkdir(join(root, TEACHING_CORPUS.docs.worker.source));
        const schemes = new SchemeRegistry({ readTeaching: teachingCorpusReader(root) });
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `teaching-unreadable-${crypto.randomUUID()}`);
        await insertWorker(db, workspaceId);

        await assert.rejects(
            () => LoopDocs.materialize(engine, db, workspaceId),
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
