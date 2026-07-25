import type { TelemetryEvent } from "@plurnk/plurnk-grammar";
import type { Db } from "./Db.ts";
import type { TelemetryEventNotify } from "./ChannelWrite.ts";

// §telemetry — the uniform error channel. Every engine failure is a terse op='error'
// log row: a status code + the canonical term, no prose (the packet teaches recovery).
// Each surfaces as a LogCoordinate TelemetryEvent derived from log≥400 — one channel,
// no per-kind handling. {§telemetry-uniform-error-channel}
const ENGINE_ERRORS = Object.freeze({
    budget_overflow: { status: 413, term: "Budget Overflow: newest log items automatically FOLDed — a retrieval larger than Tokens Free arrives folded; FOLD older items first, then fetch within the room made" },
    max_commands_exceeded: { status: 429, term: "Max Commands Exceeded" },
    // premature-terminate is NOT a terse engine-error: it's a SEND op-result (409 + an actionable
    // outcome, §send-premature-terminate) — the SEND row records the [200] attempt faithfully and
    // auto-surfaces (status≥400) like any op failure, never an erasure to 102.
    // #394 (owner wording) — states the LAW of legal turn shapes, deliberately nothing more:
    // teaching decomposition/drafting of big jobs is a grammar-level concern, never an error
    // message's (owner: "isn't going to fit in an error message").
    idle_turn: { status: 409, term: "Illegal idle turn - a [102] turn performs at least one operation. Conclude with [200] or wait with [202]." },
} as const);
export type EngineErrorKind = keyof typeof ENGINE_ERRORS;

// The model-facing alert channel: a per-loop transient buffer of actionless failures
// pending surface in the NEXT packet's user.telemetry.errors[], plus the live client
// fan-out and the uniform op='error' log-row mint. SPEC §telemetry.
export default class TelemetryChannel {
    #db: Db;
    // Per-loop transient buffer of actionless failures pending surface in the
    // NEXT packet's user.telemetry.errors[]. Drained by PacketBuilder.buildTelemetryErrors.
    // Map<loopId, TelemetryError[]>. SPEC §telemetry.
    #buffer = new Map<number, object[]>();
    // Telemetry event fan-out: every TelemetryEvent pushed to the loop's
    // buffer is also broadcast live to the connected client(s) on the
    // workspace. Without this, the client sees `loop/terminated` with a
    // status code but has no way to surface why the loop degraded.
    // Per-grammar 0.17.0 protocol — see SPEC §telemetry.
    #notify: TelemetryEventNotify | undefined;

    constructor({ db, notify }: { db: Db; notify?: TelemetryEventNotify }) {
        this.#db = db;
        this.#notify = notify;
    }

    push(workspaceId: number, loopId: number, event: TelemetryEvent): void {
        const existing = this.#buffer.get(loopId);
        if (existing === undefined) this.#buffer.set(loopId, [event]);
        else existing.push(event);
        // Live fan-out: client sees the event the moment it lands in the
        // model's buffer (not at the next packet build). Same envelope on
        // both sides per the grammar 0.17.0 TelemetryEvent protocol.
        this.#notify?.(workspaceId, { loopId, event });
    }

    // Live fan-out ONLY, never buffered — for work with no loop to drain the
    // buffer (e.g. workspace-scope derivation warming, loopId 0).
    notify(workspaceId: number, loopId: number, event: TelemetryEvent): void {
        this.#notify?.(workspaceId, { loopId, event });
    }

    // Telemetry drains as it's read into the packet — each event surfaces once. §telemetry-drain-on-read
    drain(loopId: number): object[] {
        const buf = this.#buffer.get(loopId);
        if (buf === undefined) return [];
        this.#buffer.delete(loopId);
        return buf;
    }

    delete(loopId: number): void {
        this.#buffer.delete(loopId);
    }

    // Mint an engine failure as a uniform op='error' log row (§telemetry-uniform-error-channel):
    // a terse status + canonical term keyed by `kind` (the packet teaches recovery, not the row),
    // origin engine:rail. The errors section derives its LogCoordinate pointer from log≥400 — one
    // channel, no per-kind handling.
    async mintEngineError(kind: EngineErrorKind, { workerId, loopId, turnId, sequence }: { workerId: number; loopId: number; turnId: number; sequence: number }): Promise<void> {
        const { status, term } = ENGINE_ERRORS[kind];
        await this.#db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
            origin: "plurnk", source: "rail", op: "error", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, params: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ kind, message: term }),
            mimetype_rx: "application/json",
            status_rx: status, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
    }
}
