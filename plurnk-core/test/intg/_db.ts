// Integration harness: the migrated per-test database and its row seeding. {§test-artifact-retention}

import SqlRite from "@possumtech/sqlrite";
import { Knob } from "@plurnk/plurnk-meta";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { access, copyFile, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import type { Db } from "../../src/core/Db.ts";
import type { MessageOpener } from "../../src/core/ChannelWrite.ts";
import { sqlFunctionPaths } from "../../src/core/sql-functions.ts";
import { sqliteSynchronous } from "../../src/core/sqlite-synchronous.ts";
import GitMembership from "../../src/core/git-membership.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket, { type DurablePacket } from "../../src/core/StoredPacket.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MIGRATIONS_DIR = resolve(PROJECT_ROOT, "migrations");

// File-backed per-test DB so on-disk consumers (the digest tool) exercise the suite's real
// artifacts. Per-test UUID filenames eliminate parallel collisions.
//
// {§test-artifact-retention} — the run's directory lives under PLURNK_BENCHMARKS beside every
// other harness's artifacts, so a database is born where it lives: nothing is written into the
// checkout, nothing is swept, and any test worth review is handed straight to
// `npm run share -- <the path the run reported>`.
let artifacts: Promise<string> | null = null;

const artifactDirectory = (): Promise<string> => (artifacts ??= testArtifactDirectory(process.env.PLURNK_TEST_LANE ?? "core"));

// A database the migrations alone produced, once per run and migration set: a test's fresh database is a copy of it,
// so no test pays to migrate. It holds nothing a test's own open would not have written first.
let template: Promise<string> | null = null;

const migratedTemplate = (): Promise<string> => (template ??= (async () => {
    const digest = createHash("sha256");
    for (const name of (await readdir(MIGRATIONS_DIR)).toSorted()) digest.update(name).update(await readFile(join(MIGRATIONS_DIR, name)));
    const path = join(await artifactDirectory(), `template-${digest.digest("hex").slice(0, 16)}.db`);
    if (await access(path).then(() => true, () => false)) return path;
    // Concurrent first processes each build one and rename it into place; the renames are atomic and the copies equal.
    const staging = `${path}.${crypto.randomUUID()}`;
    await mkdir(dirname(path), { recursive: true });
    const db = await SqlRite.open({ path: staging, synchronous: sqliteSynchronous(), dir: [MIGRATIONS_DIR], functions: sqlFunctionPaths });
    await db.close();
    await rename(staging, path);
    return path;
})());

// A migrated database at `atPath`, a fresh one for each test when none is given; a path that already holds a database is
// reopened. Its readers are the package's own setting unless a test names the posture it exercises.
export const openMigrated = async (atPath?: string, { readers = Knob.integer("PLURNK_SERVICE_SQLITE_READERS", 0) }: { readers?: number } = {}): Promise<Db> => {
    const dbPath = atPath ?? join(await artifactDirectory(), `db-${crypto.randomUUID()}.db`);
    await mkdir(dirname(dbPath), { recursive: true });
    if (!await access(dbPath).then(() => true, () => false)) await copyFile(await migratedTemplate(), dbPath);
    const db = await SqlRite.open({
        path: dbPath,
        synchronous: sqliteSynchronous(),
        readers,
        dir: [
            MIGRATIONS_DIR,
            resolve(PROJECT_ROOT, "src"),
            resolve(PROJECT_ROOT, "test/intg"),
        ],
        functions: sqlFunctionPaths,
    });
    return db;
};

export const insertWorkspace = async (db: Db, name: string): Promise<number> => {
    const row = await db.test_insert_workspace.get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertWorkspace: insert returned no row");
    return row.id;
};

let sessionCounter = 0;

export const insertSession = async (
    db: Db,
    workspaceId: number,
    parentSessionId: number | null = null,
    name?: string,
    origin: "model" | "_plurnk" = "model",
): Promise<number> => {
    const row = await db.test_insert_session.get<{ id: number }>({
        workspace_id: workspaceId,
        name: name ?? `session-test-${++sessionCounter}-${Math.random().toString(36).slice(2, 8)}`,
        parent_session_id: parentSessionId,
        origin,
    });
    if (row === undefined) throw new Error("insertSession: insert returned no row");
    return row.id;
};

// {§message-arrival} — a loop's nonempty initial prompt is ordinal 1 of its inbox, published on turn 1.
export const insertLoop = async (db: Db, sessionId: number, sequence: number, prompt: string = ""): Promise<number> => {
    const row = await db.test_insert_loop.get<{ id: number }>({
        session_id: sessionId, sequence, prompt,
    });
    if (row === undefined) throw new Error("insertLoop: insert returned no row");
    if (prompt.length > 0) {
        const message = await db.drain_enqueue_message.get<{ id: number }>({ loop_id: row.id, address: null, source: null, body: prompt, open_paths: "[]", evidence: "{}", opened_turn_id: null, opened_sequence: null });
        if (message === undefined) throw new Error("insertLoop: message enqueue returned no row");
    }
    return row.id;
};

// {§loop-completion}: a fixture-controlled child holds its parent without a
// provider drain. Restart recovery settles the vanished child like any other owner.
export const holdChild = async (db: Db, workspaceId: number, sessionId: number): Promise<number> => {
    const childId = await insertSession(db, workspaceId, sessionId);
    return insertLoop(db, childId, 1, "Fixture-controlled work.");
};

// {§packet} — the stored bag carries no sections; an empty composition reads back as [].
const MIN_PACKET = JSON.stringify({
    weight: 0,
    attributions: [],
    assistant: { content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

// {§packet} — store a complete packet the way the engine does: an open inference turn,
// the bag and its sections through the write view, then the turn's terminal status.
export const insertPacketTurn = async (db: Db, loopId: number, sequence: number, packet: DurablePacket, status: number = 200): Promise<number> => {
    const row = await db.test_open_inference_turn.get<{ id: number }>({ loop_id: loopId, sequence });
    if (row === undefined) throw new Error("insertPacketTurn: insert returned no row");
    await Turn.recordInference(db, row.id, {
        packet: StoredPacket.stringify(packet),
        sections: StoredPacket.sections(packet),
        usageCurationBudget: null,
        finishReason: null,
        model: "test",
        meta: "{}",
    });
    await Turn.complete(db, row.id, status);
    return row.id;
};

// Fixture root-assignment (headless-is-forever: production sets projectRoot ONLY at
// workspace.create; tests that build workspaces piecemeal root them here — a direct UPDATE plus the
// same creation-time membership resolve createClientEnvelope performs).
export const rootWorkspace = async (db: Db, workspaceId: number, root: string): Promise<void> => {
    await db.test_set_workspace_root.run({ id: workspaceId, project_root: root });
    await GitMembership.resolveGitMembership(db, workspaceId, undefined);
};

export const insertTurn = async (db: Db, loopId: number, sequence: number, status: number = 200): Promise<number> => {
    const row = await db.test_insert_turn.get<{ id: number }>({
        loop_id: loopId, sequence, status, packet: MIN_PACKET,
    });
    if (row === undefined) throw new Error("insertTurn: insert returned no row");
    return row.id;
};

// {§loop-completion} The operation by which a session sends a message: a completed turn of the sender's loop, at its
// next sequence, with the sending row first in it. Fixtures name it as the message's opener, as a SEND, WORK or FORK does.
export const sendingOperation = async (db: Db, loopId: number): Promise<MessageOpener> => {
    const next = await db.drain_next_turn_seq_for_loop.get<{ next: number }>({ loop_id: loopId });
    if (next === undefined) throw new Error("sendingOperation: the sender's loop has no next turn");
    return { turnId: await insertTurn(db, loopId, next.next, 200), sequence: 1 };
};

export const insertOperationTurn = async (
    db: Db,
    loopId: number,
    sequence: number,
    producer: "client" | "_plurnk",
    status: number = 200,
): Promise<number> => {
    const row = await db.test_insert_operation_turn.get<{ id: number }>({
        loop_id: loopId,
        sequence,
        producer,
        status,
    });
    if (row === undefined) throw new Error("insertOperationTurn: insert returned no row");
    return row.id;
};

export const seedEnvelope = async (
    db: Db,
    label: string,
    options: { producer?: "model" | "client" | "_plurnk"; prompt?: string } = {},
): Promise<{
    workspaceId: number; sessionId: number; loopId: number; turnId: number;
}> => {
    const workspaceId = await insertWorkspace(db, label);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, options.prompt);
    const producer = options.producer ?? "model";
    const { id: turnId } = await Turn.open(db, { loopId, producer, kind: producer === "model" ? "inference" : "operation" });
    return { workspaceId, sessionId, loopId, turnId };
};

// Seed an entry with one channel + visibility row, bypassing scheme handlers.
// Used by tests that need precise DB state for render / visibility / streaming
// assertions.
export const seedEntryWithChannel = async (
    db: Db,
    opts: {
        workspaceId: number;
        defaultChannel?: string;
        output?: boolean;
        scheme?: string;
        authority?: string;
        pathname?: string;
        channel?: string;
        content?: string;
        mimetype?: string;
        state?: "static" | "active" | "closed" | "errored";
    },
): Promise<number> => {
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: opts.workspaceId,
        scheme: opts.scheme ?? ((opts.authority ?? "") === "" ? "workspace" : "session"),
        authority: opts.authority ?? "",
        pathname: opts.pathname ?? "/x",
        default_channel: opts.defaultChannel ?? opts.channel ?? "body",
        output: opts.output === true ? 1 : 0,
    });
    if (entry === undefined) throw new Error("seedEntryWithChannel: insert returned no row");
    await db.test_seed_channel.run({
        entry_id: entry.id,
        name: opts.channel ?? "body",
        content: opts.content ?? "",
        mimetype: opts.mimetype ?? "text/plain",
        state: opts.state ?? "static",
    });
    return entry.id;
};
