import { resolveModelSelector } from "@plurnk/plurnk-providers";
import type { ProviderAlias, ProviderSpec } from "@plurnk/plurnk-providers";
import Results, { OperationFailureError } from "../core/results.ts";

// {§methods-loop-run-model}: resolve a runLoop call's optional selector to the
// ProviderSpec to instantiate, or null for "use the boot default". PURE (no env read, no
// construction) so the precedence + parse contract is hermetically testable; the Daemon wraps it
// with ProviderInstantiate + the #provider fallback.
//
// One selector accepts either a declared alias or an exact provider/model route.
// A malformed route or undeclared alias throws legibly — the daemon must never
// silently run the wrong model.
export const resolveLoopRoute = (
    selector: string | undefined,
    declared: readonly ProviderAlias[],
): ProviderSpec | null => {
    if (selector === undefined) return null;
    const route = resolveModelSelector(selector, declared);
    if (route !== null) return route;
    const exact = selector.includes("/");
    throw new OperationFailureError(Results.failure(
        "daemon:provider",
        exact ? "model-spec-invalid" : "alias-not-found",
        exact ? 400 : 404,
        exact
            ? `Model selector '${selector}' is not a provider/model specification.`
            : `Provider alias '${selector}' is not declared.`,
        {},
        {
            selector,
            stage: "provider-selection",
            recovery: exact
                ? "Use a provider/model specification."
                : "Select a declared alias or use a provider/model specification.",
            retryable: false,
        },
    ));
};
