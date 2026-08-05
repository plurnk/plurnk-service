// {§digest-programmatic-surface}: the package subpath is a pure import and its
// selectors prune complete forensic graphs, not implementation-private arrays.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Db } from "../../src/core/Db.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const execFileP = promisify(execFile);

interface DigestJson {
    workspaces: Array<{ id: number; cost_usd: number }>;
    workers: Array<{ id: number; workspace_id: number; cost_usd: number }>;
    loops: Array<{ id: number; worker_id: number; prompt: string }>;
    turns: Array<{ id: number; loop_id: number; usage_prompt: number }>;
    turn_attempts: Array<{ turn_id: number; model: string }>;
    log_entries: Array<{ worker_id: number; loop_id: number; turn_id: number; target: string | null }>;
}

const seedWorkerEvidence = async (
    db: Db,
    workspaceId: number,
    marker: string,
    ordinal: number,
    op: string,
): Promise<{ workerId: number; loopId: number; turnId: number }> => {
    const workerId = await insertWorker(db, workspaceId, null, `worker-${marker}`);
    const loopId = await insertLoop(db, workerId, 1, `prompt-${marker}`);
    const turnId = await insertTurn(db, loopId, 1, 200);
    const turn = await db.test_get_turn.get<{ packet: string }>({ id: turnId });
    if (turn === undefined) throw new Error(`seedWorkerEvidence: turn ${turnId} is missing`);
    await db.engine_close_turn.run({
        id: turnId,
        status: 200,
        packet: turn.packet,
        usage_prompt: ordinal * 100,
        usage_completion: ordinal * 10,
        usage_reasoning: ordinal,
        usage_cached: 0,
        usage_cost_usd: ordinal / 1000,
        finish_reason: "stop",
        model: `model-${marker}`,
        meta: "{}",
    });
    await db.engine_record_turn_attempt.run({
        turn_id: turnId,
        sequence: 1,
        accepted: 1,
        response: JSON.stringify({ assistant: { reasoning: `reason-${marker}` } }),
        parse_errors: "[]",
        usage_prompt: ordinal * 100,
        usage_completion: ordinal * 10,
        usage_reasoning: ordinal,
        usage_cached: 0,
        usage_cost_usd: ordinal / 1000,
        finish_reason: "stop",
        model: `model-${marker}`,
    });
    await db.engine_insert_log_entry.run({
        worker_id: workerId,
        loop_id: loopId,
        turn_id: turnId,
        sequence: 1,
        origin: "model",
        source: null,
        op,
        suffix: "",
        signal: null,
        scheme: "worker",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: `/${marker}`,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: "{}",
        mimetype_tx: "application/json",
        rx: JSON.stringify({ status: 200, content: marker }),
        mimetype_rx: "application/json",
        status_rx: 200,
        tokens: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
    return { workerId, loopId, turnId };
};

test("{§digest-programmatic-surface}: importing the public subpath performs no process or filesystem action", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-import-"));
    const packageRoot = resolve(import.meta.dirname, "../..");
    try {
        await writeFile(join(dir, "before-import"), "sentinel");
        const program = `
            import { writeFileSync } from "node:fs";
            process.argv = [process.execPath, "digest", "--invalid-if-parsed"];
            console.log = () => { throw new Error("digest import called console.log"); };
            console.error = () => { throw new Error("digest import called console.error"); };
            process.exit = (code) => { throw new Error(\`digest import called process.exit(\${code})\`); };
            process.chdir(${JSON.stringify(dir)});
            await import("@plurnk/plurnk-service/digest");
            writeFileSync("after-import", "returned");
        `;
        const result = await execFileP(process.execPath, [
            "--conditions=plurnk-dev",
            "--input-type=module",
            "--eval",
            program,
        ], {
            cwd: packageRoot,
            env: {
                ...process.env,
                HOME: dir,
                NODE_NO_WARNINGS: "1",
                PLURNK_SERVICE_DB_PATH: join(dir, "must-not-exist.db"),
            },
        });
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
        assert.deepEqual((await readdir(dir)).toSorted(), ["after-import", "before-import"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§digest-programmatic-surface}: selectors prune emitted evidence and each selected directory is recreated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-programmatic-"));
    const dbPath = join(dir, "plurnk.db");
    const db = await openMigrated(dbPath);
    let workspaceA = 0;
    let workspaceB = 0;
    let a1: Awaited<ReturnType<typeof seedWorkerEvidence>>;
    let a2: Awaited<ReturnType<typeof seedWorkerEvidence>>;
    let b1: Awaited<ReturnType<typeof seedWorkerEvidence>>;
    try {
        workspaceA = await insertWorkspace(db, "digest-workspace-a");
        workspaceB = await insertWorkspace(db, "digest-workspace-b");
        a1 = await seedWorkerEvidence(db, workspaceA, "a1", 1, "READ");
        a2 = await seedWorkerEvidence(db, workspaceA, "a2", 2, "EDIT");
        b1 = await seedWorkerEvidence(db, workspaceB, "b1", 3, "COPY");
    } finally {
        await db.close();
    }

    const { default: Digest } = await import("@plurnk/plurnk-service/digest");
    const run = async (
        name: string,
        selectors: { workerId?: number; workspaceId?: number },
    ): Promise<{ json: DigestJson; markdown: string; reasoning: string; files: string[] }> => {
        const digestDir = join(dir, name);
        await mkdir(digestDir, { recursive: true });
        await writeFile(join(digestDir, "packet999.user.md"), "stale packet");
        Digest.run({ dbPath, digestDir, ...selectors });
        const files = (await readdir(digestDir)).toSorted();
        assert.ok(!files.includes("packet999.user.md"), `${name} directory was wiped before rendering`);
        return {
            json: JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as DigestJson,
            markdown: await readFile(join(digestDir, "digest.md"), "utf8"),
            reasoning: await readFile(join(digestDir, "reasoning.md"), "utf8"),
            files,
        };
    };

    try {
        const worker = await run("worker", { workerId: a1.workerId });
        assert.deepEqual(worker.json.workspaces.map(({ id }) => id), [workspaceA]);
        assert.deepEqual(worker.json.workers.map(({ id }) => id), [a1.workerId]);
        assert.deepEqual(worker.json.loops.map(({ id }) => id), [a1.loopId]);
        assert.deepEqual(worker.json.turns.map(({ id }) => id), [a1.turnId]);
        assert.deepEqual(worker.json.turn_attempts.map(({ turn_id }) => turn_id), [a1.turnId]);
        assert.deepEqual(worker.json.log_entries.map(({ turn_id }) => turn_id), [a1.turnId]);
        assert.deepEqual(worker.json.workers.map(({ cost_usd }) => cost_usd), [0.001]);
        assert.deepEqual(worker.json.turns.map(({ usage_prompt }) => usage_prompt), [100]);
        assert.match(worker.markdown, /prompt-a1/);
        assert.match(worker.markdown, /Tokens:\s+prompt=100 completion=10 reasoning=1 cached=0/);
        assert.match(worker.markdown, /Cost:\s+\$0\.001000/);
        assert.match(worker.markdown, /Op mix:\s+READ=1/);
        assert.match(worker.reasoning, /reason-a1/);
        assert.doesNotMatch(`${JSON.stringify(worker.json)}${worker.markdown}${worker.reasoning}`, /(?:prompt|reason)-(?:a2|b1)/);
        assert.doesNotMatch(worker.markdown, /(?:\$0\.002000|\$0\.003000|Op mix:\s+(?:EDIT|COPY)=1)/);
        assert.ok(worker.files.includes("packet000.user.md"));
        assert.ok(!worker.files.some((file) => file.startsWith("packet001")));

        const workspace = await run("workspace", { workspaceId: workspaceA });
        assert.deepEqual(workspace.json.workspaces.map(({ id }) => id), [workspaceA]);
        assert.ok(workspace.json.workers.every(({ workspace_id }) => workspace_id === workspaceA));
        assert.deepEqual(
            workspace.json.workers.filter(({ id }) => id === a1.workerId || id === a2.workerId).map(({ id }) => id),
            [a1.workerId, a2.workerId],
        );
        assert.deepEqual(workspace.json.loops.map(({ id }) => id), [a1.loopId, a2.loopId]);
        assert.deepEqual(workspace.json.turns.map(({ id }) => id), [a1.turnId, a2.turnId]);
        assert.deepEqual(workspace.json.turn_attempts.map(({ turn_id }) => turn_id), [a1.turnId, a2.turnId]);
        assert.deepEqual(workspace.json.log_entries.map(({ turn_id }) => turn_id), [a1.turnId, a2.turnId]);
        assert.deepEqual(
            workspace.json.workers
                .filter(({ id }) => id === a1.workerId || id === a2.workerId)
                .map(({ cost_usd }) => cost_usd),
            [0.001, 0.002],
        );
        assert.match(workspace.markdown, /prompt-a1/);
        assert.match(workspace.markdown, /prompt-a2/);
        assert.match(workspace.markdown, /Op mix:\s+READ=1/);
        assert.match(workspace.markdown, /Op mix:\s+EDIT=1/);
        assert.doesNotMatch(`${JSON.stringify(workspace.json)}${workspace.markdown}${workspace.reasoning}`, /(?:prompt|reason)-b1/);
        assert.doesNotMatch(workspace.markdown, /(?:\$0\.003000|Op mix:\s+COPY=1)/);
        assert.ok(workspace.files.some((file) => file.startsWith("packet001")));

        const intersection = await run("intersection", { workerId: b1.workerId, workspaceId: workspaceA });
        assert.deepEqual(intersection.json.workspaces, []);
        assert.deepEqual(intersection.json.workers, []);
        assert.deepEqual(intersection.json.loops, []);
        assert.deepEqual(intersection.json.turns, []);
        assert.deepEqual(intersection.json.turn_attempts, []);
        assert.deepEqual(intersection.json.log_entries, []);
        assert.doesNotMatch(`${intersection.markdown}${intersection.reasoning}`, /(?:prompt|reason)-(?:a1|a2|b1)/);
        assert.ok(!intersection.files.some((file) => file.startsWith("packet")));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
