// Runtime enable/disable policy — a REGISTRATION bound, sibling to the trust
// gate (discover.ts `#isTrusted`), NOT the §3.2 activation overlay. A disabled
// tag is not registered at all: neither Active nor Available, simply absent. So
// the consumer can honor "a client may freely activate any registered
// capability" (§3.2) while the registered set itself is bounded per layer.
//
// Grammar (the `PLURNK_EXECS_*` namespace — same at every tier):
//   PLURNK_EXECS_<TAG>=0 | false   surgical kill-switch for one tag
//   PLURNK_EXECS_ONLY=a,b,c        allowlist — a tag not listed is disabled
// The two compose within a layer (a listed tag can still be individually
// killed). `ONLY` is a reserved key: a runtime tag may not be named "only".
//
// PURELY SUBTRACTIVE — there is no force-enable verb, and that is the whole
// point: intersect layers (service ∩ client ∩ …) and a downstream layer can
// only ever narrow. The client can never re-enable a tag the service disabled,
// structurally, not by a policed rule.
//
// `env` is the policy LAYER: `process.env` for the daemon's boot layer
// (discover's default), or a client-declared map in the exact same
// `PLURNK_EXECS_*` format for the per-session client layer. One parser, both
// tiers — the consumer feeds the client's map straight to these methods.
export default class Policy {
    // Read a PLURNK_EXECS_<suffix> key case-INSENSITIVELY. The env-var
    // convention is uppercase, but an operator/agent naturally writes the tag as
    // it appears (PLURNK_EXECS_sh=0) — matching the tag they see, not shouting
    // it — and a case-sensitive miss would silently no-op (service#328). Fold
    // the key the way the mcp config already folds server names. Direct hit
    // first (the common uppercase form), then a folded scan.
    static #read(env: Record<string, string | undefined>, suffix: string): string | undefined {
        const key = `PLURNK_EXECS_${suffix.toUpperCase()}`;
        if (key in env) return env[key];
        const hit = Object.keys(env).find((k) => k.toUpperCase() === key);
        return hit === undefined ? undefined : env[hit];
    }

    static isEnabled(tag: string, env: Record<string, string | undefined> = process.env): boolean {
        const off = Policy.#read(env, tag);
        if (off === "0" || off?.toLowerCase() === "false") return false;
        const only = Policy.#read(env, "ONLY");
        if (only) {
            const allow = new Set(only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
            if (!allow.has(tag.toLowerCase())) return false;
        }
        return true;
    }

    // The cascade: enabled iff enabled in EVERY layer. Intersection is
    // order-independent and monotonic — pass `[serviceEnv, clientLayer]` (or
    // more) and no layer can undo another's disable.
    static enabledAcross(tag: string, layers: Array<Record<string, string | undefined>>): boolean {
        return layers.every((layer) => Policy.isEnabled(tag, layer));
    }
}
