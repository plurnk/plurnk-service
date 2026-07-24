// Canonical op-result contract for `@plurnk/plurnk-schemes-*` siblings and
// their consumer (plurnk-service). Replaces the per-op result types that
// forked in-tree (plurnk-service `_entry-ops.ts` vs the local redefinitions
// in `File.ts` / `Exec.ts` / `Log.ts`).
//
// SchemeResult expresses the engine's actual universal invariant: every
// handler result has a numeric status and may carry scheme-owned metadata.
// EntryResult, ProposalResult, and PassthroughResult are optional authoring
// aids for schemes that benefit from those conventional shapes; the engine
// does not require or branch on their `shape` discriminator.
//
// Three shapes cover the current set:
//   entry       — entries + entry_channels backed (known/unknown/skill/plurnk)
//   proposal    — propose-then-resolve with payload (file/exec)
//   passthrough — read-only / coordinate-addressed / network (log, future http)
//
// Error surface: `error` is a grammar `TelemetryEvent` (not a bare string),
// present iff `status >= 400`. The consumer mirrors it into
// `packet.user.telemetry.errors[]` unchanged.

// grammar 0.20.0 exports TelemetryEvent + LogCoordinate from its index
// (closed plurnk-grammar#23 — earlier versions only shipped the type in
// types.generated.d.ts, forcing a ReturnType<PlurnkParseError[...]> recovery).
import type { LogCoordinate, TelemetryEvent } from "@plurnk/plurnk-grammar";

export type { TelemetryEvent };

export interface SchemeResult {
    readonly status: number;
    readonly error?: unknown;
    readonly [field: string]: unknown;
}

export interface SchemeResultBase extends SchemeResult {
    readonly error?: TelemetryEvent;
}

export interface EntryResult extends SchemeResultBase {
    readonly shape: "entry";
    readonly entryId: number | null;
    readonly channel: string | null;
    readonly content?: string | null;
    readonly mimetype?: string | null;
    readonly startLine?: number | null;
    readonly matches?: number | null;
    readonly reason?: string;
}

export interface ProposalResult extends SchemeResultBase {
    readonly shape: "proposal";
    readonly body?: string;
    readonly attrs?: object;
    readonly diff?: string;
}

export interface PassthroughResult extends SchemeResultBase {
    readonly shape: "passthrough";
    readonly content?: string | null;
    readonly mimetype?: string | null;
    readonly startLine?: number | null;
    readonly matches?: number | null;
    readonly reason?: string;
}

export default class Results {
    static isEntry(result: SchemeResult): result is EntryResult {
        return "shape" in result && result.shape === "entry";
    }

    static isProposal(result: SchemeResult): result is ProposalResult {
        return "shape" in result && result.shape === "proposal";
    }

    static isPassthrough(result: SchemeResult): result is PassthroughResult {
        return "shape" in result && result.shape === "passthrough";
    }

    // A result is an error result iff its status is in the 4xx/5xx range. The
    // `error` envelope is expected on those and absent otherwise.
    static isErrorStatus(status: number): boolean {
        return status >= 400;
    }

    // Build a scheme-sourced TelemetryEvent. `source` is `scheme:<name>` per
    // the envelope's producer-namespacing convention (grammar TelemetryEvent
    // schema). Absent message/position are omitted rather than set to
    // undefined so the emitted object matches the wire shape exactly.
    static error(
        scheme: string,
        kind: string,
        message?: string | null,
        position?: TelemetryEvent["position"],
    ): TelemetryEvent {
        return {
            source: `scheme:${scheme}`,
            kind,
            level: "error",
            ...(message === undefined ? {} : { message }),
            ...(position === undefined ? {} : { position }),
        };
    }

    // Build a LogCoordinate position pointing at an action's log row. The
    // engine knows the coordinate at result-time, so schemes rarely construct
    // this directly — it's here for the consumer-side mirror and for schemes
    // that surface errors against a known prior coordinate.
    static logCoordinate(coordinate: string, op?: string): LogCoordinate {
        return {
            type: "log-coordinate",
            coordinate,
            ...(op === undefined ? {} : { op }),
        };
    }
}
