import type { ProviderAlias } from "@plurnk/plurnk-providers";

// #414 — per-loop model selection: resolve a runLoop call's optional (alias, model) to the
// ProviderAlias to instantiate, or null for "use the boot default". PURE (no env read, no
// construction) so the precedence + parse contract is hermetically testable; the Daemon wraps it
// with ProviderInstantiate + the #provider fallback.
//
// Precedence: `model` (client-resolved `<provider>/<model>`, #90) wins over a named `alias`.
// A malformed model spec or an undeclared alias throws legibly — the daemon must never silently
// run the wrong model.
export const resolveLoopAlias = (
    alias: string | undefined,
    model: string | undefined,
    declared: readonly ProviderAlias[],
): ProviderAlias | null => {
    if (typeof model === "string" && model.length > 0) {
        const slash = model.indexOf("/");
        if (slash <= 0) throw new Error(`runLoop: model must be '<provider>/<model>' (got '${model}')`);
        // A client-resolved spec is alias-independent (#90): the provider's own env carries the
        // base URL, so the synthetic alias name is cosmetic (reuse the given alias if present).
        return { alias: alias ?? model, provider: model.slice(0, slash), model: model.slice(slash + 1) };
    }
    if (typeof alias === "string" && alias.length > 0) {
        const resolved = declared.find((a) => a.alias === alias.toLowerCase());
        if (resolved === undefined) throw new Error(`runLoop: alias '${alias}' is not declared (set PLURNK_MODEL_${alias}=<provider>/<model>)`);
        return resolved;
    }
    return null;  // neither → the daemon's boot default
};
