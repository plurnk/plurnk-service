import { createHash } from "node:crypto";

// Content identity — the sha256 of a channel's content, stamped at entry-write
// (entry_channels.content_hash). It is independent of the adjacent curation
// weight ({§tokenomics}).
export const contentHash = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");
