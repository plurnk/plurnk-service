// Canonical op-result contract — single source of truth is now
// @plurnk/plurnk-schemes (keystone PR-1). The types re-export from the
// daughter; the logic delegates to its functions behind a local OO facade
// (mandate: stateless transforms are static-method classes), so in-tree call
// sites stay `Results.schemeError(...)` while the implementation lives in the
// daughter — "pull, don't copy."
//
// The shape keys on SCHEME-SHAPE, not op: entry (known/unknown/skill/plurnk),
// proposal (file/exec), passthrough (log, future http). `error` is a grammar
// `TelemetryEvent`, present iff `status >= 400`; the consumer mirrors it into
// `packet.user.telemetry.errors[]` unchanged.
import {
    isEntryResult as _isEntryResult,
    isProposalResult as _isProposalResult,
    isPassthroughResult as _isPassthroughResult,
    isErrorStatus as _isErrorStatus,
    schemeError as _schemeError,
    logCoordinate as _logCoordinate,
} from "@plurnk/plurnk-schemes";
import type {
    EntryResult, ProposalResult, PassthroughResult, SchemeResult, SchemeResultBase, TelemetryEvent,
} from "@plurnk/plurnk-schemes";
import type { LogCoordinate } from "@plurnk/plurnk-grammar";

export type { EntryResult, ProposalResult, PassthroughResult, SchemeResult, SchemeResultBase, TelemetryEvent };

export default class Results {
    static isEntryResult(r: SchemeResult): r is EntryResult { return _isEntryResult(r); }
    static isProposalResult(r: SchemeResult): r is ProposalResult { return _isProposalResult(r); }
    static isPassthroughResult(r: SchemeResult): r is PassthroughResult { return _isPassthroughResult(r); }

    // A result is an error result iff its status is in the 4xx/5xx range; the
    // `error` envelope is expected on those and absent otherwise.
    static isErrorStatus(status: number): boolean { return _isErrorStatus(status); }

    // Build a scheme-sourced TelemetryEvent (`source: scheme:<name>`).
    static schemeError(scheme: string, kind: string, message?: string | null, position?: TelemetryEvent["position"]): TelemetryEvent {
        return _schemeError(scheme, kind, message, position);
    }

    // Build a LogCoordinate position pointing at an action's log row.
    static logCoordinate(coordinate: string, op?: string): LogCoordinate { return _logCoordinate(coordinate, op); }
}
