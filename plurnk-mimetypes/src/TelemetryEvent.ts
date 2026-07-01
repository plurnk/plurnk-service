// Cross-ecosystem error/telemetry envelope. The grammar (@plurnk/plurnk-grammar,
// schema/TelemetryEvent.json) OWNS this contract, but the type is baked in here —
// the framework carries NO runtime grammar dependency (it's a type, erased at
// runtime; a runtime dep would drag grammar into every consumer's install AND
// chain the framework's release cadence to grammar's). Drift can't creep back:
// TelemetryEvent.drift.test.ts imports grammar as a BUILD-TIME devDep and fails
// tsc if this copy diverges from the contract. Generate-from-contract per §61,
// minus the coupling.
//
// Producers (mimetype handlers, framework error sites) emit these into
// packet.user.telemetry.events[]; consumers route on `source` + `kind`, color on
// `level`. `additionalProperties: true` in the schema → `[k: string]: unknown`.
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
// grammar's source pattern is `^[a-z]+(:[a-z][a-z0-9-]*)?$`, which doesn't admit
// the `/` (or `+`) in real mimetype identifiers — we substitute `_` so e.g.
// `application/json` → `mimetype:application_json`. Shared by every framework
// producer so the normalization can't drift between them.
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
