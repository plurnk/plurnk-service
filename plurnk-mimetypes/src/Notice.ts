// The grammar (@plurnk/plurnk-grammar, schema/Notice.json) owns this
// transient observation contract, but the type is baked in here —
// the framework carries NO runtime grammar dependency (it's a type, erased at
// runtime; a runtime dep would drag grammar into every consumer's install AND
// chain the framework's release cadence to grammar's). Drift can't creep back:
// Notice.drift.test.ts imports grammar as a BUILD-TIME devDep and fails
// tsc if this copy diverges from the contract. Generate-from-contract per §61,
// minus the coupling.
//
// `additionalProperties: true` in the schema permits producer-specific fields.
export type NoticeLevel = "error" | "warn" | "info";

export interface Notice {
    readonly source: string;
    readonly kind: string;
    readonly level: NoticeLevel;
    readonly message?: string | null;
    readonly position?: ContentOffset | LogCoordinate | null;
    readonly [k: string]: unknown;
}

// Build a `mimetype:<type>` source token for Notice envelopes. The
// grammar's source pattern is `^[a-z]+(:[a-z][a-z0-9-]*)?$`, which doesn't admit
// the `/` (or `+`) in real mimetype identifiers — we substitute `-` so e.g.
// `application/json` → `mimetype:application-json`. Shared by every framework
// producer so the normalization can't drift between them.
export function mimetypeSource(mimetype: string): string {
    return `mimetype:${mimetype.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
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
