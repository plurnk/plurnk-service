// Subtractive runtime registration policy ({§executor-policy}). A disabled tag
// is absent from the registry. Consumers may reuse the same parser for narrower
// workspace layers.
//
// Grammar (the `PLURNK_EXECS_*` namespace — same at every tier):
//   PLURNK_EXECS_<TAG>=0 | false   surgical kill-switch for one tag
//   PLURNK_EXECS_ONLY=a,b,c        allowlist — a tag not listed is disabled
// The two compose within a layer (a listed tag can still be individually
// killed). `only` is not an admissible runtime tag because it names this
// allowlist key ({§executor-runtime-declaration}).
//
// PURELY SUBTRACTIVE: intersecting layers means no downstream layer can restore
// a tag removed upstream.
//
// `env` is one policy layer: `process.env` at discovery, or any consumer-owned
// map using the same `PLURNK_EXECS_*` grammar.
import RuntimeTag from "./RuntimeTag.ts";

export default class Policy {
    static isKey(key: string): boolean {
        const prefix = "PLURNK_EXECS_";
        if (key.slice(0, prefix.length).toUpperCase() !== prefix) return false;
        const suffix = key.slice(prefix.length).toLowerCase();
        return suffix === "only" || RuntimeTag.is(suffix);
    }

    // Read a PLURNK_EXECS_<suffix> key case-INSENSITIVELY. The env-var
    // convention is uppercase, but matching is case-insensitive so a natural
    // lowercase tag spelling does not silently miss. Try the conventional form
    // first, then scan folded keys.
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
        if (only !== undefined) {
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
