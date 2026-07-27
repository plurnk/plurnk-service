import type { TelemetryEvent } from "@plurnk/plurnk-grammar";
import type { TelemetryEventNotify } from "./ChannelWrite.ts";

// The transient notice channel. Durable operation failures live in log_entries as
// RFC 9457 Problem Details; this buffer carries progress and diagnostic events only.
export default class TelemetryChannel {
    #buffer = new Map<number, object[]>();
    // Telemetry event fan-out: every TelemetryEvent pushed to the loop's
    // buffer is also broadcast live to the connected client(s) on the
    // workspace. Without this, the client sees `loop/terminated` with a
    // status code but has no way to surface why the loop degraded.
    // Per-grammar 0.17.0 protocol — see SPEC §telemetry.
    #notify: TelemetryEventNotify | undefined;

    constructor({ notify }: { notify?: TelemetryEventNotify } = {}) {
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
}
