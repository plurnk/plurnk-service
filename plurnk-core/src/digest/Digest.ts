#!/usr/bin/env node
//
// Worker-digest tool for plurnk-service DBs. Reads a sqlite plurnk*.db and
// emits per-worker forensic artifacts to test/digest/. First-order forensic
// surface; read-only; safe to re-run.
//
//   test/digest/digest.md           Health triage rollup (clean/degenerate-win/failed loops) +
//                                   worker-shape header + waterfall (per-loop health verdict; per-turn:
//                                   status, ⚠ errs=N, source-artifact summary, indented op list)
//   test/digest/digest.json         Same data, machine-queryable
//   test/digest/reasoning.md        Every provider attempt's reasoning and admission result
//   test/digest/requiem.md          Out-of-band model audit
//   test/digest/requiem.json        Exact audit messages, responses, usage, and cost
//   test/digest/packetNNN.system.md       BYTE-FOR-BYTE the system message sent
//                                         when the turn involved a provider.
//   test/digest/packetNNN.user.md         User text slot; digest.json retains native attachment descriptors.
//   test/digest/packetNNN.response.md      Request-only note when no response was admitted.
//   test/digest/packetNNN.assistant.md     Exact persisted turnOps, regardless of producer.
//   test/digest/packetNNN.assistantRaw.json  Opaque provider response.
//   test/digest/packetNNN.packet.raw.txt      Exact malformed stored packet text.
//   test/digest/packetNNN.packet.invalid.json Validation failure for that packet.
//   test/digest/packetNNN.attemptNNN.rejected.assistant.md
//                                          Rejected provider emission.
//   test/digest/packetNNN.attemptNNN.rejected.response.json
//                                          Full rejected provider response.
//   test/digest/packetNNN.attemptNNN.rejected.parse-errors.json
//                                          Admission errors for that attempt.
//
// Provider request slots are byte-identical to what Engine emits because both
// paths project through PacketWire. Assistant files preserve durable turnOps.
//
// SQL lives in the co-located digest.sql; opened the sqlrite way (SqlRiteSync,
// the sync CLI/script facade). Each PREP block is read through its own accessor.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import { observedSync } from "../observe/spans.ts";
import StoredPacket, { type DurablePacket } from "../core/StoredPacket.ts";
import HostPaths from "../core/HostPaths.ts";
import DigestRender from "./DigestRender.ts";
import DigestRequiem from "./DigestRequiem.ts";
import type {
    SyncPrep,
    WorkspaceRow,
    WorkerRow,
    LoopRow,
    ErrorEvidence,
    PacketFailure,
    TurnRow,
    StoredTurnRow,
    TurnAttemptRow,
    InferenceCallRow,
    ModelCallRow,
    EmbeddingCallRow,
    ProviderRequestRow,
    LogRow,
    LogCurationEffectRow,
    WorkerRollupRow,
    OpMixRow,
    SemanticStateRow,
    DispositionCountRow,
    DispositionRow,
    DerivationStateRow,
    EmbeddingStateRow,
    DigestModel,
    DigestOptions,
} from "./digest-rows.ts";

const describeNonError = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};
const errorEvidence = (value: unknown, seen = new Set<unknown>()): ErrorEvidence => {
    if (seen.has(value)) return { name: "Error", message: "Circular error cause" };
    if (typeof value === "object" && value !== null) seen.add(value);
    if (!(value instanceof Error)) {
        return {
            name: "NonError",
            message: describeNonError(value),
        };
    }
    const evidence: ErrorEvidence = { name: value.name, message: value.message };
    if (value.cause !== undefined) evidence.cause = errorEvidence(value.cause, seen);
    return evidence;
};
const readStoredPacket = (raw: string | null, subject: string): {
    packet: DurablePacket | null;
    packetFailure: PacketFailure | null;
} => {
    if (raw === null) return { packet: null, packetFailure: null };
    try {
        return { packet: StoredPacket.parse(raw, subject), packetFailure: null };
    } catch (cause) {
        return { packet: null, packetFailure: { raw, error: errorEvidence(cause) } };
    }
};
export default class Digest {
    // Default DB path mirrors the host path contract and an explicit service override.
    static defaultDbPath(): string {
        const paths = new HostPaths();
        const env = process.env.PLURNK_SERVICE_DB_PATH;
        return env !== undefined && env.length > 0
            ? resolve(paths.expandUserPath(env))
            : paths.databaseFile;
    }

    // {§digest-requiem} — the out-of-band forensic interview lives in DigestRequiem.
    static requiem(opts: Parameters<typeof DigestRequiem.interview>[0]): ReturnType<typeof DigestRequiem.interview> {
        return DigestRequiem.interview(opts);
    }

    static run(opts: DigestOptions): void {
        // {§observability-boundary} — the evidence write is observed; the digest
        // paths themselves are environment-specific and stay off the boundary.
        observedSync("digest.write", {}, () => { Digest.#runSettled(opts); });
    }

    static #runSettled(opts: DigestOptions): void {
        // {§digest-programmatic-surface}: digest.sql is packaged beside this module
        // (src/digest → dist/digest via copy-sql), including in an installed package.
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const dbPath = resolve(opts.dbPath);
        if (!existsSync(dbPath)) throw new Error(`digest: no DB at ${dbPath}`);
        // A caller may select an isolated output directory; the CLI default is cwd/test/digest.
        const digestDir = opts.digestDir ?? join(process.cwd(), "test", "digest");

        // Opens without readOnly so WAL-mode DBs (the daemon's normal operating
        // mode) inspect cleanly; this tool only reads. The DB is quiescent at
        // digest time, so each PREP reads on its own — no cross-query snapshot.
        const db = new SqlRiteSync({ path: dbPath, dir: [moduleDir] });
        const tables = new Set(
            (db.digest_schema_tables as SyncPrep<{ name: string }>).all().map(({ name }) => name),
        );
        const columns = new Map<string, Set<string>>();
        const has = (table: string): boolean => tables.has(table);
        const hasColumn = (table: string, column: string): boolean => {
            let names = columns.get(table);
            if (names === undefined) {
                names = new Set(
                    (db.digest_schema_columns as SyncPrep<{ name: string }>).all({ table }).map(({ name }) => name),
                );
                columns.set(table, names);
            }
            return names.has(column);
        };
        let workspaces = (db.digest_workspaces as SyncPrep<WorkspaceRow>).all();
        let workers = (db.digest_workers as SyncPrep<WorkerRow>).all();
        let loops = (db.digest_loops as SyncPrep<LoopRow>).all();
        let turns = (db.digest_turns as SyncPrep<StoredTurnRow>).all()
            .map((turn): TurnRow => {
                const packetEvidence = readStoredPacket(turn.packet, `digest turn ${turn.id}`);
                return { ...turn, ...packetEvidence };
            });
        let inferenceCalls = (db.digest_inference_calls as SyncPrep<InferenceCallRow>).all();
        let modelCalls = (db.digest_model_calls as SyncPrep<ModelCallRow>).all();
        let embeddingCalls = (db.digest_embedding_calls as SyncPrep<EmbeddingCallRow>).all();
        let turnAttempts = (db.digest_turn_attempts as SyncPrep<TurnAttemptRow>).all();
        let providerRequests = (db.digest_provider_requests as SyncPrep<ProviderRequestRow>).all();
        let logEntries = (db.digest_log_entries as SyncPrep<LogRow>).all();
        let curationEffects: LogCurationEffectRow[] = [];
        let workerRollupRows = (db.digest_worker_rollups as SyncPrep<WorkerRollupRow>).all();
        let opMixRows = (db.digest_worker_op_mix as SyncPrep<OpMixRow>).all();
        // Historical specimens may predate individual forensic analytics. The
        // base statement set discovers their schema; only compatible static
        // SqlRite packs are opened, so absence remains evidence rather than an
        // eager-prepare failure or a reason to assemble SQL in TypeScript.
        const channelDerivations = has("entry_channels") && hasColumn("entry_channels", "deep_hash");
        const legacyEntryDerivations = has("entries") && hasColumn("entries", "deep_hash");
        const semanticStateAvailable = has("entries") && has("entry_channels")
            && (channelDerivations || legacyEntryDerivations);
        const hasDisposition = semanticStateAvailable
            && has("derivations")
            && hasColumn("derivations", "disposition");
        const queryRoot = resolve(moduleDir, "..", "..", "digest-sql");
        const queryDirs = [
            ...(has("log_curation_effects") ? [join(queryRoot, "curation")] : []),
            ...(semanticStateAvailable
                ? [join(queryRoot, channelDerivations ? "channel-state" : "entry-state")]
                : []),
            ...(hasDisposition
                ? [join(queryRoot, channelDerivations ? "channel-dispositions" : "entry-dispositions")]
                : []),
            ...(semanticStateAvailable && has("derivations") ? [join(queryRoot, "derivations")] : []),
            ...(has("derivation_embeddings") ? [join(queryRoot, "embeddings")] : []),
            ...(has("token_counts") ? [join(queryRoot, "token-counts")] : []),
        ];
        const analytics = queryDirs.length === 0
            ? null
            : new SqlRiteSync({ path: dbPath, dir: queryDirs });
        if (has("log_curation_effects")) {
            curationEffects = (analytics!.digest_curation_effects as SyncPrep<LogCurationEffectRow>).all();
        }
        const semanticState = semanticStateAvailable
            ? ((analytics![channelDerivations ? "digest_channel_semantic_state" : "digest_entry_semantic_state"] as SyncPrep<SemanticStateRow>).get()
                ?? { channel_entries: 0, derivation_complete: 0, unfinished: 0 })
            : null;
        const dispositionCounts = hasDisposition
            ? (analytics![channelDerivations ? "digest_channel_disposition_counts" : "digest_entry_disposition_counts"] as SyncPrep<DispositionCountRow>).all()
            : [];
        const dispositionCount = (value: string): number =>
            dispositionCounts.find(({ disposition }) => disposition === value)?.n ?? (hasDisposition ? 0 : -1);
        const dispositions = hasDisposition
            ? (analytics![channelDerivations ? "digest_channel_dispositions" : "digest_entry_dispositions"] as SyncPrep<DispositionRow>).all()
            : [];
        const derivationState = semanticStateAvailable && has("derivations")
            ? (analytics!.digest_derivation_state as SyncPrep<DerivationStateRow>).get()
            : undefined;
        const embeddingState = has("derivation_embeddings")
            ? (analytics!.digest_embedding_state as SyncPrep<EmbeddingStateRow>).get()
            : undefined;
        const tokenState = has("token_counts")
            ? (analytics!.digest_token_count as SyncPrep<{ n: number }>).get()
            : undefined;
        const embeddings = {
            channel_entries: semanticState?.channel_entries ?? -1,
            derivation_complete: semanticState?.derivation_complete ?? -1,
            vector_complete: dispositionCount("vector"),
            lexical: dispositionCount("lexical"),
            excluded: dispositionCount("excluded"),
            nonsemantic: dispositionCount("nonsemantic"),
            failed: dispositionCount("failed"),
            dispositions,
            unfinished: semanticState?.unfinished ?? -1,
            derivation_artifacts_complete: derivationState?.complete ?? -1,
            derivation_artifacts_building: derivationState?.building ?? -1,
            chunk_rows: embeddingState?.chunks ?? -1,
            models: embeddingState?.models ?? -1,
            token_derivations: tokenState?.n ?? -1,
        };
        analytics?.close();
        db.close();

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
            inferenceCalls = inferenceCalls.filter((call) => opts.workerId === undefined
                ? keptWorkspaceIds.has(call.workspace_id)
                : call.turn_id !== null && keptTurnIds.has(call.turn_id));
            const keptInferenceCallIds = new Set(inferenceCalls.map((call) => call.id));
            modelCalls = modelCalls.filter((call) => keptInferenceCallIds.has(call.id));
            embeddingCalls = embeddingCalls.filter((call) => keptInferenceCallIds.has(call.id));
            turnAttempts = turnAttempts.filter((attempt) => keptTurnIds.has(attempt.turn_id));
            providerRequests = providerRequests.filter((request) => keptInferenceCallIds.has(request.inference_call_id));
            logEntries = logEntries.filter((le) => keptTurnIds.has(le.turn_id));
            const keptLogEntryIds = new Set(logEntries.map((entry) => entry.id));
            curationEffects = curationEffects.filter((effect) =>
                keptLogEntryIds.has(effect.operation_log_entry_id)
                && keptLogEntryIds.has(effect.target_log_entry_id));
            workerRollupRows = workerRollupRows.filter((r) => keptWorkerIds.has(r.worker_id));
            opMixRows = opMixRows.filter((o) => keptWorkerIds.has(o.worker_id));
        }

        // Wipe-then-recreate the digest dir so each worker is a clean snapshot —
        // orphaned packet*.* files from a prior digest don't linger.
        rmSync(digestDir, { recursive: true, force: true });
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
        const logEntriesByTurn = new Map<number, LogRow[]>();
        for (const le of logEntries) { const arr = logEntriesByTurn.get(le.turn_id) ?? []; arr.push(le); logEntriesByTurn.set(le.turn_id, arr); }
        const loopsById = new Map(loops.map((l) => [l.id, l]));
        const workersById = new Map(workers.map((r) => [r.id, r]));
        const workerRollups = new Map(workerRollupRows.map((r) => [r.worker_id, r]));
        const opMixByWorker = new Map<number, OpMixRow[]>();
        for (const o of opMixRows) { const arr = opMixByWorker.get(o.worker_id) ?? []; arr.push(o); opMixByWorker.set(o.worker_id, arr); }

        const m: DigestModel = {
            dbPath, digestDir, workspaces, workers, loops, turns, inferenceCalls, modelCalls, embeddingCalls, turnAttempts, providerRequests, logEntries, curationEffects,
            workersByWorkspace, loopsByWorker, turnsByLoop, attemptsByTurn,
            requestsByInferenceCall, requestsByAttempt, requestsByTurn, requestsByLoop, requestsByWorker, requestsByWorkspace,
            logEntriesByTurn, loopsById, workersById,
            workerRollups, opMixByWorker, embeddings,
        };

        writeFileSync(join(digestDir, "digest.md"), DigestRender.waterfall(m));
        writeFileSync(join(digestDir, "digest.json"), DigestRender.json(m));
        writeFileSync(join(digestDir, "reasoning.md"), DigestRender.reasoning(m));
        const packetFiles = DigestRender.packetFiles(m);
        const packetIds = [...new Set(packetFiles.map((f) => f.slice(0, f.indexOf("."))))];

        console.log(`digest: wrote ${digestDir}/{digest.md,digest.json,reasoning.md} + ${packetFiles.length} packet artifact files (${packetIds.join(", ") || "none"})`);
        console.log(`  source: ${dbPath}`);
        console.log(`  workspaces=${workspaces.length} workers=${workers.length} loops=${loops.length} turns=${turns.length} inference_calls=${inferenceCalls.length} model_calls=${modelCalls.length} embedding_calls=${embeddingCalls.length} turn_attempts=${turnAttempts.length} provider_requests=${providerRequests.length} log_entries=${logEntries.length} log_curation_effects=${curationEffects.length}`);
    }
}
