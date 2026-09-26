// A fixed reasoning effort from a reasoning policy, and its native SDK projection.
import type { ReasoningPolicy } from "./types.ts";
import { REASONING_POLICIES } from "@plurnk/plurnk-contracts";

// {§provider-reasoning-policy} Select one declared preference, never the nearest
// or strongest effort. Unsupported leaves the enabled endpoint's default intact.
export const adaptiveEffortFromEnv = <T extends string>(
    env: NodeJS.ProcessEnv,
    supported: Iterable<T>,
): T | undefined => {
    const key = "PLURNK_PROVIDERS_REASONING_FALLBACK";
    const value = env[key];
    if (value === undefined) throw new TypeError(`${key} must be set`);
    if (value === "") return undefined;
    const fixed = REASONING_POLICIES.filter((policy) => policy !== "off" && policy !== "adaptive");
    if (!fixed.some((effort) => effort === value)) {
        throw new TypeError(`${key} must be empty or one of ${fixed.join(", ")}`);
    }
    return [...supported].find((effort) => effort === value);
};

export const fixedEffort = (mode: ReasoningPolicy): "low" | "medium" | "high" | "xhigh" | "max" => {
    if (mode === "low" || mode === "medium" || mode === "high" || mode === "xhigh" || mode === "max") return mode;
    throw new TypeError(`reasoning policy '${mode}' is not a fixed effort`);
};

// The native SDK effort surface tops at xhigh; admission never grants a native
// route "max", so reaching it here is a contract violation, not a fallback site.
export const nativeFixedEffort = (mode: ReasoningPolicy): "low" | "medium" | "high" | "xhigh" => {
    const effort = fixedEffort(mode);
    if (effort === "max") throw new TypeError(`reasoning policy 'max' has no native SDK effort surface`);
    return effort;
};
