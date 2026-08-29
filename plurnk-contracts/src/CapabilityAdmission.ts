import type {
    CapabilityDescriptor,
    CapabilityPolicy,
    CapabilitySelector,
} from "./types.generated.ts";

// {§capability-policy-matching} — selectors are exact conjunctions. Policy
// layers remain data; this class is the one deterministic evaluator shared by
// every consumer.
export default class CapabilityAdmission {
    static matches(selector: CapabilitySelector, descriptor: CapabilityDescriptor): boolean {
        if (selector.operation !== undefined && selector.operation !== descriptor.operation) return false;
        if (selector.scheme !== undefined && selector.scheme !== descriptor.scheme) return false;
        if (selector.runtime !== undefined && selector.runtime !== descriptor.runtime) return false;
        if (selector.tool !== undefined && selector.tool !== descriptor.tool) return false;
        if (selector.access !== undefined && selector.access !== descriptor.access) return false;
        if (selector.traits !== undefined
            && !selector.traits.every((trait) => descriptor.traits.includes(trait))) return false;
        return true;
    }

    static allows(policy: CapabilityPolicy, descriptor: CapabilityDescriptor): boolean {
        if (policy.deny?.some((selector) => CapabilityAdmission.matches(selector, descriptor)) === true) return false;
        return policy.only === undefined
            || policy.only.some((selector) => CapabilityAdmission.matches(selector, descriptor));
    }

    static allowsAcross(policies: readonly CapabilityPolicy[], descriptor: CapabilityDescriptor): boolean {
        return policies.every((policy) => CapabilityAdmission.allows(policy, descriptor));
    }

    // Lossless normalization of an intersection into one policy. `only` is an
    // OR-list, so intersecting two lists is their compatible Cartesian product;
    // deny lists simply union.
    static intersect(policies: readonly CapabilityPolicy[]): CapabilityPolicy {
        const deny = CapabilityAdmission.#unique(policies.flatMap((policy) => policy.deny ?? []));
        let only: CapabilitySelector[] | undefined;
        for (const policy of policies) {
            if (policy.only === undefined) continue;
            only = only === undefined
                ? [...policy.only]
                : only.flatMap((left) => policy.only!.flatMap((right) => {
                    const merged = CapabilityAdmission.#merge(left, right);
                    return merged === null ? [] : [merged];
                }));
            only = CapabilityAdmission.#unique(only);
        }
        return {
            ...(only === undefined ? {} : { only }),
            ...(deny.length === 0 ? {} : { deny }),
        };
    }

    static #merge(left: CapabilitySelector, right: CapabilitySelector): CapabilitySelector | null {
        const merged: Record<string, unknown> = {};
        for (const field of ["operation", "scheme", "runtime", "tool", "access"] as const) {
            const l = left[field];
            const r = right[field];
            if (l !== undefined && r !== undefined && l !== r) return null;
            const value = l ?? r;
            if (value !== undefined) merged[field] = value;
        }
        const traits = [...new Set([...(left.traits ?? []), ...(right.traits ?? [])])].toSorted();
        if (traits.length > 0) merged.traits = traits;
        return merged as CapabilitySelector;
    }

    static #unique(selectors: readonly CapabilitySelector[]): CapabilitySelector[] {
        const seen = new Set<string>();
        return selectors.filter((selector) => {
            const key = JSON.stringify({
                operation: selector.operation,
                scheme: selector.scheme,
                runtime: selector.runtime,
                tool: selector.tool,
                access: selector.access,
                traits: selector.traits === undefined ? undefined : [...selector.traits].toSorted(),
            });
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).toSorted((left, right) => CapabilityAdmission.#key(left).localeCompare(CapabilityAdmission.#key(right)));
    }

    static #key(selector: CapabilitySelector): string {
        return JSON.stringify({
            operation: selector.operation,
            scheme: selector.scheme,
            runtime: selector.runtime,
            tool: selector.tool,
            access: selector.access,
            traits: selector.traits === undefined ? undefined : [...selector.traits].toSorted(),
        });
    }
}
