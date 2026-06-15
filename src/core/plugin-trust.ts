// #229 — host-level plugin trust gate: the ONE place "installed = trusted?" is
// decided, read by scope-agnostic discovery across the four plugin families
// (schemes here; mimetypes/providers/execs read the SAME env in their own
// discover, so the posture is decided once and enforced uniformly).
//
// PLURNK_PLUGINS_TRUSTED_ONLY:
//   unset / "" / "0" → OFF — every installed plugin is trusted (today's behavior,
//     no regression; npm's normal "installed = trusted" model).
//   any value → ON — @plurnk/* is always first-party-trusted, plus a
//     comma-separated allowlist of additionally-trusted package names; anything
//     else is untrusted (discovered, skipped with a note, never crashed). "1" (a
//     value naming no real package) is the "on, zero third-party" sentinel.
export default class PluginTrust {
    static isTrusted(packageName: string): boolean {
        const gate = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        if (gate === undefined || gate === "" || gate === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return gate.split(",").map((s) => s.trim()).includes(packageName);
    }
}
