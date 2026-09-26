// The adaptive fallback effort, a fixed effort, and its native SDK projection.
import type { Effort } from "./types.ts";
import { EFFORTS } from "@plurnk/plurnk-contracts";

// {§provider-effort} Select one declared preference, never the nearest
// or strongest effort. Unsupported leaves the enabled endpoint's default intact.
export const adaptiveEffortFromEnv = <T extends string>(
    env: NodeJS.ProcessEnv,
    supported: Iterable<T>,
): T | undefined => {
    const key = "PLURNK_PROVIDERS_EFFORT_FALLBACK";
    const value = env[key];
    if (value === undefined) throw new TypeError(`${key} must be set`);
    if (value === "") return undefined;
    const fixed = EFFORTS.filter((policy) => policy !== "off" && policy !== "adaptive");
    if (!fixed.some((effort) => effort === value)) {
        throw new TypeError(`${key} must be empty or one of ${fixed.join(", ")}`);
    }
    return [...supported].find((effort) => effort === value);
};

export const fixedEffort = (mode: Effort): "low" | "medium" | "high" | "xhigh" | "max" => {
    if (mode === "low" || mode === "medium" || mode === "high" || mode === "xhigh" || mode === "max") return mode;
    throw new TypeError(`effort '${mode}' is not a fixed effort`);
};

// The native SDK effort surface tops at xhigh; admission never grants a native
// route "max", so reaching it here is a contract violation, not a fallback site.
export const nativeFixedEffort = (mode: Effort): "low" | "medium" | "high" | "xhigh" => {
    const effort = fixedEffort(mode);
    if (effort === "max") throw new TypeError(`effort 'max' has no native SDK effort surface`);
    return effort;
};
