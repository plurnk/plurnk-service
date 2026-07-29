export type {
    ContentOffset,
    LogCoordinate,
    Notice,
} from "@plurnk/plurnk-contracts";

export type NoticeLevel = "error" | "warn" | "info";

// Build a `mimetype:<type>` source token for Notice envelopes. The
// grammar's source pattern is `^[a-z]+(:[a-z][a-z0-9-]*)?$`, which doesn't admit
// the `/` (or `+`) in real mimetype identifiers — we substitute `-` so e.g.
// `application/json` → `mimetype:application-json`. Shared by every framework
// producer so the normalization can't drift between them.
export function mimetypeSource(mimetype: string): string {
    return `mimetype:${mimetype.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
}
