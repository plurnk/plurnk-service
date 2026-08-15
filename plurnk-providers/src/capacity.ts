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

export const requestCapacityDecision = (
    inputCapacity: number | null,
    measurement: PromptTokenMeasurement,
): ProviderRequestCapacity["decision"] => {
    const prompt = assertPromptTokenMeasurement(measurement, "provider capacity");
    // An upper bound can prove fit when it is below the limit, but exceeding
    // the limit proves nothing about the unknown exact count. Estimates never
    // authorize or reject; the provider remains the capacity oracle.
    return inputCapacity === null
        || prompt.kind === "estimate"
        || prompt.kind === "unavailable"
        ? "defer"
        : prompt.tokens <= inputCapacity
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
    reasoningBudget,
    measurement,
}: {
    contextWindow: number | null;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    outputBudget: number | null;
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
    const inputCapacity = effectiveInputCapacity({ contextWindow, maxInputTokens, outputBudget });

    return {
        decision: requestCapacityDecision(inputCapacity, prompt),
        contextWindow,
        maxInputTokens,
        maxOutputTokens,
        outputBudget,
        reasoningBudget,
        inputCapacity,
        prompt,
    };
};
