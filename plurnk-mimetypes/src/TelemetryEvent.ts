// Cross-ecosystem error/telemetry envelope. Local TypeScript definition that
// mirrors the schema defined by @plurnk/plurnk-grammar — `schema/
// TelemetryEvent.json` over there is the source of truth. We keep a parallel
// type here rather than depending on plurnk-grammar so the framework stays
// consumable by anyone, even without grammar installed.
//
// Producers (mimetype handlers, framework error sites) emit these into
// `packet.user.telemetry.events[]` per plurnk-service's render pipeline.
// Consumers route on `source` + `kind` — open-vocabulary discriminators
// minted producer-side. `additionalProperties: true` at the schema layer
// lets producers extend without coordinating changes; we treat extra fields
// as `[k: string]: unknown` here.
//
// `level` is REQUIRED (grammar #43): severity is meaning, and the producer is
// the only party that knows whether a condition is an error, a warning, or a
// note. Setting it here lets clients color the 📡 line straight off the wire
// instead of pattern-matching `kind` strings (plurnk-service#276).
export type TelemetrySeverity = "error" | "warn" | "info";

export interface TelemetryEvent {
    readonly source: string;
    readonly kind: string;
    readonly level: TelemetrySeverity;
    readonly message?: string | null;
    readonly position?: ContentOffset | LogCoordinate | null;
    readonly [k: string]: unknown;
}

// Build a `mimetype:<type>` source token for TelemetryEvent envelopes. The
// grammar's source pattern is `^[a-z]+(:[a-z][a-z0-9-]*)?$`, which doesn't
// admit the `/` (or `+`) in real mimetype identifiers — we substitute `_` so
// e.g. `application/json` → `mimetype:application_json`. Shared by every
// framework producer so the normalization can't drift between them.
export function mimetypeSource(mimetype: string): string {
    return `mimetype:${mimetype.replace(/[^a-z0-9-]/gi, "_").toLowerCase()}`;
}

export interface ContentOffset {
    readonly type: "content-offset";
    readonly line: number;
    readonly column: number;
}

export interface LogCoordinate {
    readonly type: "log-coordinate";
    readonly coordinate: string;
    readonly op?: string;
}
