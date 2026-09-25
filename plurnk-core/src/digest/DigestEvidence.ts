import type SqlRiteSync from "@possumtech/sqlrite/sync";
import StoredPacket from "../core/StoredPacket.ts";
import type { ErrorEvidence, PacketEvidence, SyncPrep, TurnRow } from "./digest-rows.ts";

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
    if (!(value instanceof Error)) return { name: "NonError", message: describeNonError(value) };
    return {
        name: value.name, message: value.message,
        ...(value.cause === undefined ? {} : { cause: errorEvidence(value.cause, seen) }),
    };
};

// {§digest-forensic-fidelity}: heavy evidence is read on demand, never multiplied by graph size.
export default class DigestEvidence {
    readonly #db: SqlRiteSync;
    #lastPacket: { turnId: number; evidence: PacketEvidence } | undefined;

    constructor(db: SqlRiteSync) { this.#db = db; }

    packet(turn: TurnRow): PacketEvidence {
        if (this.#lastPacket?.turnId === turn.id) return this.#lastPacket.evidence;
        this.#lastPacket = undefined;
        let evidence: PacketEvidence = { packet: null, packetFailure: null };
        if (turn.has_packet === 1) {
            const row = (this.#db.digest_turn_packet as SyncPrep<{ packet: string; packet_bag: string }>).get({ turn_id: turn.id });
            if (row === undefined) throw new Error(`digest: turn ${turn.id} packet disappeared`);
            try {
                evidence = { packet: StoredPacket.parse(row.packet, `digest turn ${turn.id}`), packetFailure: null };
            } catch (cause) {
                evidence = { packet: null, packetFailure: { raw: row.packet_bag, error: errorEvidence(cause) } };
            }
        }
        this.#lastPacket = { turnId: turn.id, evidence };
        return evidence;
    }

    response(modelCallId: number): string | null {
        return (this.#db.digest_model_response as SyncPrep<{ response: string }>).get({ model_call_id: modelCallId })?.response ?? null;
    }
}
