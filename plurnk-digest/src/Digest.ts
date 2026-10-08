import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { observedSync } from "@plurnk/plurnk-meta";
import DigestRender from "./DigestRender.ts";
import DigestRequiem from "./DigestRequiem.ts";
import type { DigestEvidence } from "./evidence.ts";
import { digestPaths } from "./digest-paths.ts";
import type {
    WorkerRow,
    EditRow,
    LoopRow,
    TurnRow,
    TurnAttemptRow,
    ProviderRequestRow,
    LogRow,
    OpMixRow,
    DigestModel,
    DigestOptions,
} from "./digest-rows.ts";

export default class Digest {
    // {§digest-requiem} — the out-of-band forensic interview lives in DigestRequiem.
    static requiem(opts: Parameters<typeof DigestRequiem.interview>[0]): ReturnType<typeof DigestRequiem.interview> {
        return DigestRequiem.interview(opts);
    }

    static run(opts: DigestOptions): void {
        // {§observability-boundary} — the evidence write is observed; the digest
        // paths themselves are environment-specific and stay off the boundary.
        observedSync(trace.getTracer("@plurnk/plurnk-digest"), "digest.write", {}, () => { Digest.#runSettled(opts); });
    }

    static #runSettled(opts: DigestOptions): void {
        // {§digest-programmatic-surface}: refuse the destination before opening evidence.
        const { dbPath, digestDir } = digestPaths(opts);
        // {§share}: the digest never deletes; a caller reusing a folder removes it first.
        if (existsSync(digestDir) && (!statSync(digestDir).isDirectory() || readdirSync(digestDir).length > 0)) {
            throw new Error(`digest: ${digestDir} already exists and is not an empty folder; remove it first`);
        }
        using evidence = opts.openEvidence(dbPath);
        Digest.#write(evidence, dbPath, digestDir, opts);
    }

    static #write(evidence: DigestEvidence, dbPath: string, digestDir: string, opts: DigestOptions): void {
        const rows = evidence.rows();
        let { workspaces, workers, inferenceCalls, modelCalls, turnAttempts, providerRequests,
            logEntries, editRows, curationEffects, workerRollupRows, opMixRows } = rows;
        const { environmentRows, searchState, derivationState, dispositionCounts, dispositions, storageTables, emissionRows, reasoningRows } = rows;
        let loops = rows.loops.map((loop): LoopRow => ({ ...loop, claimed_at: loop.claimed_at ?? null }));
        if (rows.storage === undefined) throw new Error("digest: the database reported no storage facts");
        const storage = { ...rows.storage, tables: storageTables };
        let turns = rows.turns;
        if (searchState === undefined || derivationState === undefined) throw new Error("digest: search aggregate returned no row");
        const dispositionCount = (value: string): number => dispositionCounts.find(({ disposition }) => disposition === value)?.n ?? 0;
        const search = {
            ...searchState,
            indexed: dispositionCount("indexed"),
            excluded: dispositionCount("excluded"),
            unsearchable: dispositionCount("unsearchable"),
            failed: dispositionCount("failed"),
            dispositions,
            derivation_artifacts_complete: derivationState.complete,
            derivation_artifacts_building: derivationState.building,
        };

        // {§digest-programmatic-surface} — optional worker/workspace selectors narrow the
        // kept worker graph and its dependent evidence rather than emitting the whole DB.
        if (opts.workerId !== undefined) workers = workers.filter((r) => r.id === opts.workerId);
        if (opts.workspaceId !== undefined) workers = workers.filter((r) => r.workspace_id === opts.workspaceId);
        if (opts.workerId !== undefined || opts.workspaceId !== undefined) {
            const keptWorkerIds = new Set(workers.map((r) => r.id));
            const keptWorkspaceIds = new Set(workers.map((r) => r.workspace_id));
            workspaces = workspaces.filter((s) => keptWorkspaceIds.has(s.id));
            loops = loops.filter((l) => keptWorkerIds.has(l.worker_id));
            const keptLoopIds = new Set(loops.map((l) => l.id));
            turns = turns.filter((t) => keptLoopIds.has(t.loop_id));
            const keptTurnIds = new Set(turns.map((t) => t.id));
            inferenceCalls = inferenceCalls.filter((call) => keptTurnIds.has(call.turn_id));
            const keptInferenceCallIds = new Set(inferenceCalls.map((call) => call.id));
            modelCalls = modelCalls.filter((call) => keptInferenceCallIds.has(call.id));
            turnAttempts = turnAttempts.filter((attempt) => keptTurnIds.has(attempt.turn_id));
            providerRequests = providerRequests.filter((request) => keptInferenceCallIds.has(request.inference_call_id));
            logEntries = logEntries.filter((le) => keptTurnIds.has(le.turn_id));
            editRows = editRows.filter((row) => keptTurnIds.has(row.turn_id));
            const keptLogEntryIds = new Set(logEntries.map((entry) => entry.id));
            curationEffects = curationEffects.filter((effect) =>
                keptLogEntryIds.has(effect.operation_log_entry_id)
                && keptLogEntryIds.has(effect.target_log_entry_id));
            workerRollupRows = workerRollupRows.filter((r) => keptWorkerIds.has(r.worker_id));
            opMixRows = opMixRows.filter((o) => keptWorkerIds.has(o.worker_id));
        }

        mkdirSync(digestDir, { recursive: true });

        const workersByWorkspace = new Map<number, WorkerRow[]>();
        for (const r of workers) { const arr = workersByWorkspace.get(r.workspace_id) ?? []; arr.push(r); workersByWorkspace.set(r.workspace_id, arr); }
        const loopsByWorker = new Map<number, LoopRow[]>();
        for (const l of loops) { const arr = loopsByWorker.get(l.worker_id) ?? []; arr.push(l); loopsByWorker.set(l.worker_id, arr); }
        const turnsByLoop = new Map<number, TurnRow[]>();
        for (const t of turns) { const arr = turnsByLoop.get(t.loop_id) ?? []; arr.push(t); turnsByLoop.set(t.loop_id, arr); }
        const attemptsByTurn = new Map<number, TurnAttemptRow[]>();
        for (const attempt of turnAttempts) {
            const arr = attemptsByTurn.get(attempt.turn_id) ?? [];
            arr.push(attempt);
            attemptsByTurn.set(attempt.turn_id, arr);
        }
        const requestsByInferenceCall = new Map<number, ProviderRequestRow[]>();
        const requestsByAttempt = new Map<number, ProviderRequestRow[]>();
        const requestsByTurn = new Map<number, ProviderRequestRow[]>();
        const requestsByLoop = new Map<number, ProviderRequestRow[]>();
        const requestsByWorker = new Map<number, ProviderRequestRow[]>();
        const requestsByWorkspace = new Map<number, ProviderRequestRow[]>();
        const appendRequest = (map: Map<number, ProviderRequestRow[]>, id: number, request: ProviderRequestRow): void => {
            const rows = map.get(id) ?? [];
            rows.push(request);
            map.set(id, rows);
        };
        for (const request of providerRequests) {
            appendRequest(requestsByInferenceCall, request.inference_call_id, request);
            if (request.turn_attempt_id !== null) {
                appendRequest(requestsByAttempt, request.turn_attempt_id, request);
            }
            if (request.turn_id !== null) appendRequest(requestsByTurn, request.turn_id, request);
            if (request.loop_id !== null) appendRequest(requestsByLoop, request.loop_id, request);
            if (request.worker_id !== null) appendRequest(requestsByWorker, request.worker_id, request);
            appendRequest(requestsByWorkspace, request.workspace_id, request);
        }
        const editRowsByWorker = new Map<number, EditRow[]>();
        for (const row of editRows) { const arr = editRowsByWorker.get(row.worker_id) ?? []; arr.push(row); editRowsByWorker.set(row.worker_id, arr); }
        const logEntriesByTurn = new Map<number, LogRow[]>();
        for (const le of logEntries) { const arr = logEntriesByTurn.get(le.turn_id) ?? []; arr.push(le); logEntriesByTurn.set(le.turn_id, arr); }
        const loopsById = new Map(loops.map((l) => [l.id, l]));
        const workersById = new Map(workers.map((r) => [r.id, r]));
        const workerRollups = new Map(workerRollupRows.map((r) => [r.worker_id, r]));
        const environments = new Map(environmentRows.map((row) => [`${row.workspace_id}:${row.stream}`, JSON.parse(row.env) as Record<string, unknown>]));
        const opMixByWorker = new Map<number, OpMixRow[]>();
        for (const o of opMixRows) { const arr = opMixByWorker.get(o.worker_id) ?? []; arr.push(o); opMixByWorker.set(o.worker_id, arr); }

        const m: DigestModel = {
            evidence,
            dbPath, storage, digestDir, workspaces, workers, loops, turns, inferenceCalls, modelCalls, turnAttempts, providerRequests, logEntries, curationEffects,
            workersByWorkspace, loopsByWorker, turnsByLoop, attemptsByTurn,
            requestsByInferenceCall, requestsByAttempt, requestsByTurn, requestsByLoop, requestsByWorker, requestsByWorkspace,
            logEntriesByTurn, emissionRows, reasoningRows, editRows, editRowsByWorker, environments, loopsById, workersById,
            workerRollups, opMixByWorker, search,
        };

        writeFileSync(join(digestDir, "digest.md"), DigestRender.waterfall(m));
        const pending = join(digestDir, "digest.json.partial");
        const descriptor = openSync(pending, "w");
        try {
            for (const chunk of DigestRender.json(m)) writeFileSync(descriptor, chunk);
        } finally {
            closeSync(descriptor);
        }
        writeFileSync(join(digestDir, "reasoning.md"), DigestRender.reasoning(m));
        const packetFiles = DigestRender.packetFiles(m);
        const packetIds = [...new Set(packetFiles.map((f) => f.slice(0, f.indexOf("."))))];
        renameSync(pending, join(digestDir, "digest.json"));

        console.log(`digest: wrote ${digestDir}/{digest.md,digest.json,reasoning.md} + ${packetFiles.length} packet artifact files (${packetIds.join(", ") || "none"})`);
        console.log(`  source: ${dbPath}`);
        console.log(`  workspaces=${workspaces.length} workers=${workers.length} loops=${loops.length} turns=${turns.length} inference_calls=${inferenceCalls.length} model_calls=${modelCalls.length} turn_attempts=${turnAttempts.length} provider_requests=${providerRequests.length} log_entries=${logEntries.length} log_curation_effects=${curationEffects.length}`);
    }
}
