import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// {§inject} Operator packet injection is read per turn. An explicit unreadable path fails;
// unset or empty configuration contributes no section.
export const resolveInjectPath = (raw: string): string =>
    raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;

export const readPacketInject = async (): Promise<string | null> => {
    const raw = process.env.PLURNK_SERVICE_PACKET_INJECT?.trim();
    if (!raw) return null;
    return readFile(resolveInjectPath(raw), "utf8");
};

// {§policy-sections} ## Policy and ## Project Policy occupy the privileged system zone,
// distinct from freeform packet injection. A missing default contributes no section; an explicit
// unreadable override fails. Both are read per turn.
const readPolicy = async (path: string, explicit: boolean): Promise<string | null> => {
    try { return (await readFile(path, "utf8")).trim() || null; }
    catch (err) { if (explicit) throw err; return null; }
};

// System Policy: PLURNK_SERVICE_POLICY (~-expanded) or the default ~/.plurnk/AGENTS.md. An EXPLICITLY-empty
// PLURNK_SERVICE_POLICY disables it (undefined → default; "" → off; a path → that file). The Mock
// fixture clears the ambient default; each real-model harness names its exact higher-precedence policy.
export const readSystemPolicy = async (): Promise<string | null> => {
    const raw = process.env.PLURNK_SERVICE_POLICY;
    if (raw !== undefined && raw.trim() === "") return null; // explicit empty → off (test isolation)
    const env = raw?.trim();
    return readPolicy(env ? resolveInjectPath(env) : join(homedir(), ".plurnk", "AGENTS.md"), !!env);
};

// Project Policy: PLURNK_SERVICE_PROJECT (relative to projectRoot, ~-expanded) or <projectRoot>/AGENTS.md.
export const readProjectPolicy = async (projectRoot: string | null): Promise<string | null> => {
    const env = process.env.PLURNK_SERVICE_PROJECT?.trim();
    if (!env && projectRoot === null) return null; // headless, no workspace + no override
    const base = projectRoot ?? process.cwd();
    return readPolicy(env ? resolve(base, resolveInjectPath(env)) : join(base, "AGENTS.md"), !!env);
};
