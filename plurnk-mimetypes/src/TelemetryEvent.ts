// Cross-ecosystem error/telemetry envelope. The type is the GRAMMAR's — imported
// from @plurnk/plurnk-grammar (the protocol owner, schema/TelemetryEvent.json)
// rather than hand-mirrored here, so a grammar-side change (e.g. the required
// `level` from grammar #43) can't silently drift out of sync. Producers (mimetype
// handlers, framework error sites) emit these into packet.user.telemetry.events[];
// consumers route on `source` + `kind` and color on `level`.
import type { TelemetryEvent, ContentOffset, LogCoordinate } from "@plurnk/plurnk-grammar";

export type { TelemetryEvent, ContentOffset, LogCoordinate };

// Severity union, DERIVED from the imported envelope so it tracks the grammar's
// enum instead of restating it.
export type TelemetrySeverity = TelemetryEvent["level"];

// Build a `mimetype:<type>` source token for TelemetryEvent envelopes. The
// grammar's source pattern is `^[a-z]+(:[a-z][a-z0-9-]*)?$`, which doesn't admit
// the `/` (or `+`) in real mimetype identifiers — we substitute `_` so e.g.
// `application/json` → `mimetype:application_json`. Shared by every framework
// producer so the normalization can't drift between them.
export function mimetypeSource(mimetype: string): string {
    return `mimetype:${mimetype.replace(/[^a-z0-9-]/gi, "_").toLowerCase()}`;
}
