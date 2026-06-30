import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

// Policy sections (## Plurnk Service Policy / ## Project Policy) — the client's foot in the privileged
// system zone, distinct from the freeform PLURNK_PACKET_INJECT. A DEFAULT path that's absent is fine
// (no section); an EXPLICIT env override that can't be read FAILS HARD (a deliberate-but-broken
// setting is a misconfig). Read per-turn for live edits.
const readPolicy = async (path: string, explicit: boolean): Promise<string | null> => {
    try { return (await readFile(path, "utf8")).trim() || null; }
    catch (err) { if (explicit) throw err; return null; }
};

// System Policy: PLURNK_POLICY (~-expanded) or the default ~/.plurnk/AGENTS.md. An EXPLICITLY-empty
// PLURNK_POLICY disables it (undefined → default; "" → off; a path → that file). The test cascade
// (.env.test) sets it empty so test/demo/live packets never foist the operator's dogfooding policy.
export const readSystemPolicy = async (): Promise<string | null> => {
    const raw = process.env.PLURNK_POLICY;
    if (raw !== undefined && raw.trim() === "") return null; // explicit empty → off (test isolation)
    const env = raw?.trim();
    return readPolicy(env ? resolveInjectPath(env) : join(homedir(), ".plurnk", "AGENTS.md"), !!env);
};

// Project Policy: PLURNK_PROJECT (relative to projectRoot, ~-expanded) or <projectRoot>/AGENTS.md.
export const readProjectPolicy = async (projectRoot: string | null): Promise<string | null> => {
    const env = process.env.PLURNK_PROJECT?.trim();
    if (!env && projectRoot === null) return null; // headless, no workspace + no override
    const base = projectRoot ?? process.cwd();
    return readPolicy(env ? resolve(base, resolveInjectPath(env)) : join(base, "AGENTS.md"), !!env);
};
