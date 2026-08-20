import { readFile } from "node:fs/promises";
import HostPaths from "./HostPaths.ts";

// {§inject} Operator packet injection is read per turn. An explicit unreadable path fails;
// unset or empty configuration contributes no section.
export const resolveInjectPath = (raw: string): string =>
    new HostPaths().expandUserPath(raw);

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

// System Policy: PLURNK_SERVICE_POLICY (~-expanded) or the XDG config policy. An EXPLICITLY-empty
// PLURNK_SERVICE_POLICY disables it (undefined → default; "" → off; a path → that file). The Mock
// fixture clears the ambient default; each real-model harness names its exact higher-precedence policy.
export const readSystemPolicy = async (): Promise<string | null> => {
    const raw = process.env.PLURNK_SERVICE_POLICY;
    if (raw !== undefined && raw.trim() === "") return null; // explicit empty → off (test isolation)
    const env = raw?.trim();
    return readPolicy(env ? resolveInjectPath(env) : new HostPaths().policyFile, !!env);
};

// Project policy is retired from the system slot: the project AGENTS.md now
// rides turn 0 as the foisted agents.md entry ({§turn0-agents-stunt}).
