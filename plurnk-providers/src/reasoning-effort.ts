// A fixed reasoning effort from a reasoning policy, and its native SDK projection.
import type { ReasoningPolicy } from "./types.ts";

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
