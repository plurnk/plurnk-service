import type { ProviderAlias } from "@plurnk/plurnk-providers";
import Results, { OperationFailureError } from "../core/results.ts";

// {§methods-loop-run-model}: resolve a runLoop call's optional (alias, model) to the
// ProviderAlias to instantiate, or null for "use the boot default". PURE (no env read, no
// construction) so the precedence + parse contract is hermetically testable; the Daemon wraps it
// with ProviderInstantiate + the #provider fallback.
//
// Precedence: `model` (client-resolved `<provider>/<model>`) wins over a named `alias`.
// A malformed model spec or an undeclared alias throws legibly — the daemon must never silently
// run the wrong model.
export const resolveLoopAlias = (
    alias: string | undefined,
    model: string | undefined,
    declared: readonly ProviderAlias[],
): ProviderAlias | null => {
    if (typeof model === "string" && model.length > 0) {
        const slash = model.indexOf("/");
        if (slash <= 0 || slash === model.length - 1) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "model-spec-invalid",
                400,
                `Model '${model}' is not a provider/model specification.`,
                {},
                {
                    model,
                    stage: "provider-selection",
                    recovery: "Use a provider/model specification.",
                    retryable: false,
                },
            ));
        }
        // A client-resolved spec is alias-independent: the provider's own env carries the
        // base URL, so the synthetic alias name is cosmetic (reuse the given alias if present).
        return { alias: alias ?? model, provider: model.slice(0, slash), model: model.slice(slash + 1) };
    }
    if (typeof alias === "string" && alias.length > 0) {
        const resolved = declared.find((a) => a.alias === alias.toLowerCase());
        if (resolved === undefined) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "alias-not-found",
                404,
                `Provider alias '${alias}' is not declared.`,
                {},
                {
                    alias,
                    stage: "provider-selection",
                    recovery: "Select a declared provider alias.",
                    retryable: false,
                },
            ));
        }
        return resolved;
    }
    return null;  // neither → the daemon's boot default
};
