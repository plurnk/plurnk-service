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

// {§policy-sections} The policy owns its headings in the privileged system slot.
// A missing default contributes no section; an explicit unreadable override fails.
const readPolicy = async (path: string, explicit: boolean): Promise<string | null> => {
    try { return (await readFile(path, "utf8")).trim() || null; }
    catch (err) { if (explicit) throw err; return null; }
};

// {§policy-sections}: the panel's PLURNK_SERVICE_POLICY (~-expanded), or when unset the policy member
// of {§host-path-layout}; an explicitly empty value is off.
export const readSystemPolicy = async (): Promise<string | null> => {
    const raw = process.env.PLURNK_SERVICE_POLICY;
    if (raw !== undefined && raw.trim() === "") return null; // explicit empty → off (test isolation)
    const env = raw?.trim();
    return readPolicy(env ? resolveInjectPath(env) : new HostPaths().policyFile, !!env);
};
