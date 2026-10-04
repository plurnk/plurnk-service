import type {
    PromptTokenMeasurement,
    ProviderRequestCapacity,
} from "./types.ts";
import { assertPromptTokenMeasurement } from "./promptTokens.ts";

const positiveOrNull = (value: number | null, name: string): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer or null`);
    }
    return value;
};

export const effectiveOutputBudget = ({
    requested,
    configured,
    maxOutputTokens,
    contextWindow,
}: {
    requested?: number;
    configured: number | null;
    maxOutputTokens: number | null;
    contextWindow: number | null;
}): number | null => {
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
        throw new TypeError("maxOutputTokens must be a positive safe integer");
    }
    const policies = [requested ?? null, configured].filter((value): value is number => value !== null);
    if (policies.length === 0) return null;
    const physical = [
        positiveOrNull(maxOutputTokens, "maxOutputTokens"),
        positiveOrNull(contextWindow, "contextWindow"),
    ].filter((value): value is number => value !== null);
    return Math.min(...policies, ...physical);
};

export const effectiveReasoningBudget = ({
    configured,
    outputBudget,
}: {
    configured: number | null;
    outputBudget: number | null;
}): number | null => {
    positiveOrNull(configured, "reasoningBudget");
    positiveOrNull(outputBudget, "outputBudget");
    if (configured === null) return null;
    if (outputBudget === null) {
        throw new TypeError("a reasoning budget requires a resolved total output budget");
    }
    if (outputBudget < 2) {
        throw new TypeError("maxOutputTokens must leave at least one token outside the reasoning budget");
    }
    return Math.min(configured, outputBudget - 1);
};

// {§provider-output-floor}: the floor is never above the output budget, so a
// call that tightens the budget below the configured floor tightens the floor
// with it.
export const effectiveOutputFloor = ({
    configured,
    outputBudget,
}: {
    configured: number | null;
    outputBudget: number | null;
}): number | null => {
    positiveOrNull(configured, "outputFloor");
    positiveOrNull(outputBudget, "outputBudget");
    return configured === null || outputBudget === null
        ? configured
        : Math.min(configured, outputBudget);
};

export const effectiveInputCapacity = ({
    contextWindow,
    maxInputTokens,
    outputBudget,
}: {
    contextWindow: number | null;
    maxInputTokens: number | null;
    outputBudget: number | null;
}): number | null => {
    positiveOrNull(contextWindow, "contextWindow");
    positiveOrNull(maxInputTokens, "maxInputTokens");
    positiveOrNull(outputBudget, "outputBudget");
    const combinedCapacity = contextWindow !== null && outputBudget !== null
        ? contextWindow - outputBudget
        : null;
    if (combinedCapacity !== null && combinedCapacity <= 0) {
        throw new TypeError(
            `outputBudget (${outputBudget}) must leave positive input capacity inside contextWindow (${contextWindow})`,
        );
    }
    const capacities = [
        maxInputTokens,
        combinedCapacity,
    ].filter((value): value is number => value !== null);
    return capacities.length === 0 ? null : Math.min(...capacities);
};

// {§provider-output-floor}: the input wall is every known physical input
// constraint intersected — independent maxInputTokens and the window less the
// output floor. Null when neither is known.
export const effectiveInputWall = ({
    contextWindow,
    maxInputTokens,
    outputFloor,
}: {
    contextWindow: number | null;
    maxInputTokens: number | null;
    outputFloor: number | null;
}): number | null => {
    positiveOrNull(contextWindow, "contextWindow");
    positiveOrNull(maxInputTokens, "maxInputTokens");
    positiveOrNull(outputFloor, "outputFloor");
    const windowWall = contextWindow !== null && outputFloor !== null
        ? contextWindow - outputFloor
        : null;
    if (windowWall !== null && windowWall <= 0) {
        throw new TypeError(
            `outputFloor (${outputFloor}) must leave positive input room inside contextWindow (${contextWindow})`,
        );
    }
    const walls = [
        maxInputTokens,
        windowWall,
    ].filter((value): value is number => value !== null);
    return walls.length === 0 ? null : Math.min(...walls);
};

// {§provider-flexed-allowance}: the wire margin kept between the measured prompt and the grant.
export const WIRE_FLEX_MARGIN = 256;

// {§provider-flexed-allowance}: the grant is the window's remainder after the
// prompt and the margin. An exact prompt takes the remainder itself, clamped
// between the floor and the model's own output limit — above the reservation
// when the prompt left room, down to the floor when it ate into the
// reservation. Any other measurement, and a pool, keeps the reservation,
// clamped by the same remainder so the wire never asks the window for more
// than it has, and never below the floor. No window, no budget or no count:
// the reservation stands.
export const flexedResponseMax = ({
    contextWindow,
    maxOutputTokens,
    outputBudget,
    outputFloor,
    promptTokens,
    margin,
    exact,
}: {
    contextWindow: number | null;
    maxOutputTokens: number | null;
    outputBudget: number | null;
    outputFloor: number | null;
    promptTokens: number | null;
    margin: number;
    exact: boolean;
}): number | null => {
    if (outputBudget === null || contextWindow === null || promptTokens === null) return outputBudget;
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
        throw new TypeError("promptTokens must be a non-negative safe integer");
    }
    const least = outputFloor ?? outputBudget;
    const remainder = contextWindow - promptTokens - margin;
    if (!exact) return Math.max(least, Math.min(outputBudget, remainder));
    const flexed = Math.max(least, remainder);
    return maxOutputTokens === null ? flexed : Math.min(flexed, Math.max(outputBudget, maxOutputTokens));
};

// {§provider-capacity-admission}: admission is decided against the input wall,
// never the curation reservation.
export const requestCapacityDecision = (
    inputWall: number | null,
    measurement: PromptTokenMeasurement,
): ProviderRequestCapacity["decision"] => {
    const prompt = assertPromptTokenMeasurement(measurement, "provider capacity");
    // An upper bound can prove fit when it is below the wall, but exceeding
    // the wall proves nothing about the unknown exact count. Estimates never
    // authorize or reject; the provider remains the capacity oracle.
    return inputWall === null
        || prompt.kind === "estimate"
        || prompt.kind === "unavailable"
        ? "defer"
        : prompt.tokens <= inputWall
            ? "admit"
            : prompt.kind === "exact"
                ? "reject"
                : "defer";
};

export const assessRequestCapacity = ({
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    outputBudget,
    outputFloor,
    reasoningBudget,
    measurement,
}: {
    contextWindow: number | null;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    outputBudget: number | null;
    outputFloor: number | null;
    reasoningBudget: number | null;
    measurement: PromptTokenMeasurement;
}): ProviderRequestCapacity => {
    positiveOrNull(contextWindow, "contextWindow");
    positiveOrNull(maxInputTokens, "maxInputTokens");
    positiveOrNull(maxOutputTokens, "maxOutputTokens");
    positiveOrNull(outputBudget, "outputBudget");
    positiveOrNull(reasoningBudget, "reasoningBudget");
    if (reasoningBudget !== null
        && (outputBudget === null || reasoningBudget >= outputBudget)) {
        throw new TypeError("reasoningBudget must be a strict subset of outputBudget");
    }
    const prompt = assertPromptTokenMeasurement(measurement, "provider capacity");
    const floor = effectiveOutputFloor({ configured: outputFloor, outputBudget });
    const inputCapacity = effectiveInputCapacity({ contextWindow, maxInputTokens, outputBudget });
    const inputWall = effectiveInputWall({ contextWindow, maxInputTokens, outputFloor: floor });
    const responseMax = flexedResponseMax({
        contextWindow,
        maxOutputTokens,
        outputBudget,
        outputFloor: floor,
        promptTokens: prompt.kind === "unavailable" ? null : prompt.tokens,
        margin: WIRE_FLEX_MARGIN,
        exact: prompt.kind === "exact",
    });

    return {
        decision: requestCapacityDecision(inputWall, prompt),
        contextWindow,
        maxInputTokens,
        maxOutputTokens,
        outputBudget,
        outputFloor: floor,
        reasoningBudget,
        inputCapacity,
        inputWall,
        responseMax,
        prompt,
    };
};
