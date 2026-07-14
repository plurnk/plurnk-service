import { createHash } from "node:crypto";

// Content identity — the sha256 of a channel's content, stamped at entry-write
// (entry_channels.content_hash). A stable per-content key; the per-model token cache that once
// rode it was retired with the agnostic-ruler simplification (§tokenomics-agnostic-ruler).
export const contentHash = (content: string): string => createHash("sha256").update(content).digest("hex");
