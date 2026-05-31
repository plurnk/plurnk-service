// Canonical op-result contract for `@plurnk/plurnk-schemes-*` siblings and
// their consumer (plurnk-service). Replaces the per-op result types that
// forked in-tree (plurnk-service `_entry-ops.ts` vs the local redefinitions
// in `File.ts` / `Exec.ts` / `Log.ts`).
//
// The shape keys on SCHEME-SHAPE, not op. EDIT against `known://` and EDIT
// against `file://` produce structurally different results because the
// schemes are differently shaped, not because EDIT is. So a family is the
// superset of fields its shape can return across every op (entry-shape READ
// returns content; entry-shape EDIT returns entryId) — fields optional per
// op, discriminated by `shape`.
//
// Three shapes cover the current set:
//   entry       — entries + entry_channels backed (known/unknown/skill/plurnk)
//   proposal    — propose-then-resolve with payload (file/exec)
//   passthrough — read-only / coordinate-addressed / network (log, future http)
//
// Error surface: `error` is a grammar `TelemetryEvent` (not a bare string),
// present iff `status >= 400`. The consumer mirrors it into
// `packet.user.telemetry.errors[]` unchanged.

// grammar 0.17.0 ships TelemetryEvent in types.generated.d.ts but does NOT
// re-export it by name from the package index, and its exports map exposes
// only "." — so neither a named import nor a deep path resolves. Recover the
// type from PlurnkParseError.toTelemetryEvent()'s return (PlurnkParseError
// IS index-exported). Upstream gap tracked at plurnk-grammar#22; switch to a
// named import once it lands.
import type { PlurnkParseError } from "@plurnk/plurnk-grammar";

type TelemetryEvent = ReturnType<PlurnkParseError["toTelemetryEvent"]>;

// LogCoordinate is the log-coordinate arm of TelemetryEvent's `position`
// union. Derive it structurally rather than depending on a named export.
type LogCoordinate = Extract<NonNullable<TelemetryEvent["position"]>, { type: "log-coordinate" }>;

export type { TelemetryEvent };

export interface SchemeResultBase {
    readonly status: number;
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

export type SchemeResult = EntryResult | ProposalResult | PassthroughResult;

export const isEntryResult = (result: SchemeResult): result is EntryResult => result.shape === "entry";
export const isProposalResult = (result: SchemeResult): result is ProposalResult => result.shape === "proposal";
export const isPassthroughResult = (result: SchemeResult): result is PassthroughResult => result.shape === "passthrough";

// A result is an error result iff its status is in the 4xx/5xx range. The
// `error` envelope is expected on those and absent otherwise.
export const isErrorStatus = (status: number): boolean => status >= 400;

// Build a scheme-sourced TelemetryEvent. `source` is `scheme:<name>` per
// the envelope's producer-namespacing convention (grammar TelemetryEvent
// schema). Absent message/position are omitted rather than set to undefined
// so the emitted object matches the wire shape exactly.
export const schemeError = (
    scheme: string,
    kind: string,
    message?: string | null,
    position?: TelemetryEvent["position"],
): TelemetryEvent => ({
    source: `scheme:${scheme}`,
    kind,
    ...(message === undefined ? {} : { message }),
    ...(position === undefined ? {} : { position }),
});

// Build a LogCoordinate position pointing at an action's log row. The engine
// knows the coordinate at result-time, so schemes rarely construct this
// directly — it's here for the consumer-side mirror and for schemes that
// surface errors against a known prior coordinate.
export const logCoordinate = (coordinate: string, op?: string): LogCoordinate => ({
    type: "log-coordinate",
    coordinate,
    ...(op === undefined ? {} : { op }),
});
