// {§digest-programmatic-surface}: the package subpath is a pure import and its
// selectors prune complete forensic graphs, not implementation-private arrays.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProviderAccounting, ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { Db } from "../../src/core/Db.ts";
import Turn from "../../src/core/Turn.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, testDeferredProviderCapacity } from "./_helpers.ts";

const execFileP = promisify(execFile);

interface DigestJson {
    workspaces: Array<{ id: number; accounting: ProviderAccounting }>;
    workers: Array<{ id: number; workspace_id: number; accounting: ProviderAccounting }>;
    loops: Array<{ id: number; worker_id: number; prompt: string }>;
    turns: Array<{ id: number; loop_id: number; accounting: ProviderAccounting }>;
    inference_calls: Array<{
        id: number;
        workspace_id: number;
        turn_id: number | null;
        kind: "emission" | "bare" | "embedding_query" | "embedding_documents";
        accounting: ProviderAccounting;
    }>;
    model_calls: Array<{
        id: number;
        turn_id: number;
        kind: "emission" | "bare";
        log_entry_id: number | null;
        accounting: ProviderAccounting;
    }>;
    embedding_calls: Array<{
        id: number;
        workspace_id: number;
        turn_id: number | null;
        kind: "embedding_query" | "embedding_documents";
        accounting: ProviderAccounting;
    }>;
    turn_attempts: Array<{ turn_id: number; model: string }>;
    provider_requests: Array<{ inference_call_id: number; turn_attempt_id: number | null; accounting: ProviderRequestAccounting }>;
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
    const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
    const turnId = turn.id;
    await Turn.recordInference(db, turnId, {
        packet: JSON.stringify({ weight: 0, sections: [], attributions: [] }),
        usageCurationBudget: null,
        finishReason: "stop",
        model: `model-${marker}`,
        meta: "{}",
    });
    await Turn.complete(db, turnId, 200);
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turnId,
        kind: "emission",
        attributions: "[]",
        model: `model-${marker}`,
    });
    if (modelCall === undefined) throw new Error("digest fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        model_call_id: modelCall.id,
    });
    if (attempt === undefined) throw new Error("digest fixture attempt did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:digest-fixture",
        model: `model-${marker}`,
        outcome: "response",
        usage: {
            inputTokens: ordinal * 100,
            outputTokens: ordinal * 10,
            totalTokens: ordinal * 110,
            inputTokenDetails: { noCacheTokens: ordinal * 100, cacheReadTokens: 0 },
            outputTokenDetails: { textTokens: ordinal * 9, reasoningTokens: ordinal },
        },
        cost: {
            kind: "charged",
            amount: { amount: `0.00${ordinal}`, currency: "USD" },
            source: "digest fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("digest fixture provider request did not open");
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request.id, accounting),
    );
    assert.equal(settled.changes, 1);
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        response: JSON.stringify({ assistant: { reasoning: `reason-${marker}` } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("digest:fixture")),
        finish_reason: "stop",
        model: `model-${marker}`,
    });
    await db.engine_classify_turn_attempt_response.run({
        id: attempt.id,
        accepted: 1,
        parse_errors: "[]",
    });
    await db.engine_insert_log_entry.run({
        worker_id: workerId,
        loop_id: loopId,
        turn_id: turnId,
        sequence: 1,
        origin: "model",
        source: null,
        model_call_id: null,
        op,
        delimiter: "",
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
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
    return { workerId, loopId, turnId };
};

const seedWorkspaceEmbeddingEvidence = async (db: Db, workspaceId: number): Promise<number> => {
    const call = await db.engine_open_embedding_call.get<{ id: number }>({
        workspace_id: workspaceId,
        turn_id: null,
        kind: "embedding_query",
        model: "digest-embedding",
    });
    if (call === undefined) throw new Error("digest embedding call did not open");
    assert.equal((await db.engine_prepare_embedding_call.run({ id: call.id, input_count: 1 })).changes, 1);
    const accounting: ProviderRequestAccounting = {
        provider: "provider:digest-embedding",
        model: "digest-embedding",
        outcome: "response",
        usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
        cost: {
            kind: "charged",
            amount: { amount: "0.004", currency: "USD" },
            source: "digest embedding fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: call.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("digest embedding provider request did not open");
    assert.equal((await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request.id, accounting),
    )).changes, 1);
    assert.equal((await db.engine_observe_embedding_call_response.run({
        id: call.id,
        output_count: 1,
        metadata: JSON.stringify({ inputTokens: 4, warnings: [] }),
    })).changes, 1);
    return call.id;
};

const seedBareEvidence = async (
    db: Db,
    coordinates: { workerId: number; loopId: number; turnId: number },
): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: coordinates.turnId,
        kind: "bare",
        attributions: JSON.stringify(["provider:digest-bare"]),
        model: "digest-bare",
    });
    if (modelCall === undefined) throw new Error("digest BARE model call did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:digest-bare",
        model: "digest-bare",
        outcome: "response",
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
        cost: {
            kind: "estimated",
            amount: { amount: "0", currency: "USD" },
            source: "digest BARE fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("digest BARE provider request did not open");
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        response: JSON.stringify({ assistant: { content: "Berlin", reasoning: null } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("digest:bare-fixture")),
        finish_reason: "stop",
        model: accounting.model,
    });
    await db.engine_insert_log_entry.run({
        worker_id: coordinates.workerId,
        loop_id: coordinates.loopId,
        turn_id: coordinates.turnId,
        sequence: 2,
        origin: "model",
        source: null,
        model_call_id: modelCall.id,
        op: "BARE",
        delimiter: "0",
        signal: JSON.stringify(["+fact"]),
        scheme: null,
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: null,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: JSON.stringify({ op: "BARE", body: "What is the capital of Germany?" }),
        mimetype_tx: "application/json",
        rx: JSON.stringify({ status: 200, content: "Berlin", mimetype: "text/plain" }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
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
    let workspaceEmbeddingCallId = 0;
    try {
        workspaceA = await insertWorkspace(db, "digest-workspace-a");
        workspaceB = await insertWorkspace(db, "digest-workspace-b");
        a1 = await seedWorkerEvidence(db, workspaceA, "a1", 1, "READ");
        await seedBareEvidence(db, a1);
        a2 = await seedWorkerEvidence(db, workspaceA, "a2", 2, "EDIT");
        workspaceEmbeddingCallId = await seedWorkspaceEmbeddingEvidence(db, workspaceA);
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
        assert.deepEqual(worker.json.inference_calls.map(({ kind }) => kind), ["emission", "bare"]);
        assert.deepEqual(worker.json.model_calls.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId]);
        assert.deepEqual(worker.json.model_calls.map(({ kind }) => kind), ["emission", "bare"]);
        assert.ok(worker.json.model_calls[1]?.log_entry_id !== null);
        assert.deepEqual(worker.json.embedding_calls, []);
        assert.deepEqual(worker.json.turn_attempts.map(({ turn_id }) => turn_id), [a1.turnId]);
        assert.equal(worker.json.provider_requests.length, 2);
        assert.equal(worker.json.provider_requests[1]?.turn_attempt_id, null);
        assert.deepEqual(worker.json.log_entries.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId]);
        assert.deepEqual(worker.json.workers.map(({ accounting }) => accounting.costUsd), ["0.001"]);
        assert.deepEqual(worker.json.turns.map(({ accounting }) => accounting.usage?.inputTokens), [100]);
        assert.match(worker.markdown, /prompt-a1/);
        assert.match(worker.markdown, /Tokens:\s+input=100 output=10 reasoning=1 cache-read=0/);
        assert.match(worker.markdown, /Cost:\s+\$0\.001/);
        assert.match(worker.markdown, /Op mix:\s+BARE=1 READ=1/);
        assert.match(
            worker.markdown,
            /^Policy: capabilities=\{\} proposals=review$/mu,
            "the digest projects the canonical loop policy without legacy flag terminology",
        );
        assert.doesNotMatch(worker.markdown, /Flags:|\[object Object\]/u);
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
        assert.deepEqual(workspace.json.inference_calls.map(({ kind }) => kind), [
            "emission",
            "bare",
            "emission",
            "embedding_query",
        ]);
        assert.deepEqual(workspace.json.model_calls.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId, a2.turnId]);
        assert.deepEqual(workspace.json.embedding_calls.map(({ id, turn_id, kind }) => ({ id, turn_id, kind })), [{
            id: workspaceEmbeddingCallId,
            turn_id: null,
            kind: "embedding_query",
        }]);
        assert.deepEqual(workspace.json.turn_attempts.map(({ turn_id }) => turn_id), [a1.turnId, a2.turnId]);
        assert.equal(workspace.json.provider_requests.length, 4);
        assert.equal(workspace.json.workspaces[0]?.accounting.costUsd, "0.007");
        assert.deepEqual(workspace.json.log_entries.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId, a2.turnId]);
        assert.deepEqual(
            workspace.json.workers
                .filter(({ id }) => id === a1.workerId || id === a2.workerId)
                .map(({ accounting }) => accounting.costUsd),
            ["0.001", "0.002"],
        );
        assert.match(workspace.markdown, /prompt-a1/);
        assert.match(workspace.markdown, /prompt-a2/);
        assert.match(workspace.markdown, /Op mix:\s+BARE=1 READ=1/);
        assert.match(workspace.markdown, /Op mix:\s+EDIT=1/);
        assert.doesNotMatch(`${JSON.stringify(workspace.json)}${workspace.markdown}${workspace.reasoning}`, /(?:prompt|reason)-b1/);
        assert.doesNotMatch(workspace.markdown, /(?:\$0\.003000|Op mix:\s+COPY=1)/);
        assert.ok(workspace.files.some((file) => file.startsWith("packet000")));
        assert.ok(workspace.files.some((file) => file.startsWith("packet001")));
        assert.ok(!workspace.files.some((file) => file.startsWith("packet002")));

        const intersection = await run("intersection", { workerId: b1.workerId, workspaceId: workspaceA });
        assert.deepEqual(intersection.json.workspaces, []);
        assert.deepEqual(intersection.json.workers, []);
        assert.deepEqual(intersection.json.loops, []);
        assert.deepEqual(intersection.json.turns, []);
        assert.deepEqual(intersection.json.inference_calls, []);
        assert.deepEqual(intersection.json.model_calls, []);
        assert.deepEqual(intersection.json.embedding_calls, []);
        assert.deepEqual(intersection.json.turn_attempts, []);
        assert.deepEqual(intersection.json.provider_requests, []);
        assert.deepEqual(intersection.json.log_entries, []);
        assert.doesNotMatch(`${intersection.markdown}${intersection.reasoning}`, /(?:prompt|reason)-(?:a1|a2|b1)/);
        assert.ok(!intersection.files.some((file) => file.startsWith("packet")));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
