import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// #240 — PLURNK_PACKET_INJECT: an operator markdown file injected as a system-slot section after
// the teaching (the cached prefix). The operator-side complement to the plugin `transformSections`
// hook — a pressure valve so "improve the packet" reshapes operator content, not the core. Read
// PER-TURN (live edits, least surprise); a set-but-unreadable path FAILS HARD (a deliberate setting
// with a broken path is a misconfig, surfaced not hidden). Unset/empty → no section.
export const resolveInjectPath = (raw: string): string =>
    raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;

export const readPacketInject = async (): Promise<string | null> => {
    const raw = process.env.PLURNK_PACKET_INJECT?.trim();
    if (!raw) return null;
    return readFile(resolveInjectPath(raw), "utf8");
};
