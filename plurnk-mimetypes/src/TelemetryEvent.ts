// Cross-ecosystem error/telemetry envelope. Local TypeScript definition that
// mirrors the schema defined by @plurnk/plurnk-grammar v0.17.0+ —
// `dist/schema/TelemetryEvent.json` over there is the source of truth. We
// keep a parallel type here rather than depending on plurnk-grammar so the
// framework stays consumable by anyone, even without grammar installed.
//
// Producers (mimetype handlers, framework error sites) emit these into
// `packet.user.telemetry.events[]` per plurnk-service's render pipeline.
// Consumers route on `source` + `kind` — open-vocabulary discriminators
// minted producer-side. `additionalProperties: true` at the schema layer
// lets producers extend without coordinating changes; we treat extra fields
// as `[k: string]: unknown` here.
export interface TelemetryEvent {
    readonly source: string;
    readonly kind: string;
    readonly message?: string | null;
    readonly position?: ContentOffset | LogCoordinate | null;
    readonly [k: string]: unknown;
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
