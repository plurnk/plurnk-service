// Cross-ecosystem error/telemetry envelope. Local TypeScript definition that
// mirrors the schema defined by @plurnk/plurnk-grammar v0.17.0+ —
// `dist/schema/TelemetryEvent.json` over there is the source of truth. We
// keep a parallel type here rather than depending on plurnk-grammar so the
// framework stays consumable by anyone, even without grammar installed.
//
// Executors emit these via the `emit` sink in ExecArgs (service#174 Q3); the
// consuming scheme wires that sink to the engine's telemetry buffer, the same
// path grammar's `parse_error` takes. Consumers route on `source` + `kind` —
// open-vocabulary discriminators minted producer-side. Executors use
// `source: "exec:<runtime>"` (e.g. "exec:search") or "scheme:exec".
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
