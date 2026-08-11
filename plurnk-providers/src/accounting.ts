import type {
    ChargedCost,
    ProviderAccounting,
    ProviderCost,
    ProviderCostNormalizer,
    ProviderRequestAccounting,
    ProviderUsage,
} from "./types.ts";
import {
    sumProviderCostsUsd,
    validateChargedCost,
    validateProviderCost,
} from "./cost.ts";
import { validateProviderUsage } from "./usage.ts";

const recordOf = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const decimalFromNumber = (value: number, subject: string): string => {
    if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${subject} must be a finite non-negative number`);
    }
    const source = String(value);
    if (!/[eE]/.test(source)) return source;
    const [coefficient, exponentSource] = source.toLowerCase().split("e");
    const exponent = Number(exponentSource);
    const [integer, fraction = ""] = coefficient!.split(".");
    const digits = `${integer}${fraction}`;
    const point = integer!.length + exponent;
    if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`;
    return `${digits.slice(0, point)}.${digits.slice(point)}`;
};

const usdFromTicks = (ticks: number): string => {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
        throw new TypeError("xAI costInUsdTicks must be a non-negative safe integer");
    }
    const digits = String(ticks).padStart(11, "0");
    const integer = digits.slice(0, -10).replace(/^0+(?=\d)/, "");
    const fraction = digits.slice(-10).replace(/0+$/, "");
    return fraction === "" ? integer : `${integer}.${fraction}`;
};

const xaiCost: ProviderCostNormalizer = ({ usage }) => {
    const wireUsage = recordOf(usage);
    if (wireUsage === null || !("cost_in_usd_ticks" in wireUsage)) return undefined;
    const ticks = wireUsage.cost_in_usd_ticks;
    if (typeof ticks !== "number") {
        throw new TypeError("xAI usage.cost_in_usd_ticks must be numeric");
    }
    return {
        kind: "charged",
        amount: { amount: String(ticks), currency: "USDTICK" },
        usdEquivalent: usdFromTicks(ticks),
        source: "xAI response usage.cost_in_usd_ticks",
    };
};

const openRouterCost: ProviderCostNormalizer = ({ providerMetadata }) => {
    const usage = recordOf(recordOf(recordOf(providerMetadata)?.openrouter)?.usage);
    if (usage === null || !("cost" in usage)) return undefined;
    const cost = usage.cost;
    if (typeof cost !== "number") throw new TypeError("OpenRouter usage.cost must be numeric");
    return {
        kind: "charged",
        amount: { amount: decimalFromNumber(cost, "OpenRouter usage.cost"), currency: "USD" },
        source: "OpenRouter response usage.cost",
    };
};

const deepInfraCost: ProviderCostNormalizer = ({ usage }) => {
    const wireUsage = recordOf(usage);
    if (wireUsage === null || !("estimated_cost" in wireUsage)) return undefined;
    const cost = wireUsage.estimated_cost;
    if (typeof cost !== "number") throw new TypeError("DeepInfra usage.estimated_cost must be numeric");
    return {
        kind: "estimated",
        amount: { amount: decimalFromNumber(cost, "DeepInfra usage.estimated_cost"), currency: "USD" },
        source: "DeepInfra response usage.estimated_cost",
    };
};

// The first-party endpoint owns the direct charged-cost wire field.
export const plurnkCostNormalizer: ProviderCostNormalizer = ({ charge }) => {
    if (charge === undefined) return undefined;
    return validateChargedCost(charge) as ChargedCost;
};

export const providerCostNormalizer = (
    sdkPackage: string,
): ProviderCostNormalizer | undefined => {
    switch (sdkPackage) {
        case "@ai-sdk/xai": return xaiCost;
        case "@ai-sdk/deepinfra": return deepInfraCost;
        case "@openrouter/ai-sdk-provider": return openRouterCost;
        default: return undefined;
    }
};

export const validateProviderRequestAccounting = (
    value: unknown,
): ProviderRequestAccounting => {
    const request = recordOf(value);
    if (request === null) throw new TypeError("provider request accounting must be an object");
    if (typeof request.provider !== "string" || request.provider.length === 0) {
        throw new TypeError("provider request accounting.provider must be non-empty");
    }
    if (typeof request.model !== "string" || request.model.length === 0) {
        throw new TypeError("provider request accounting.model must be non-empty");
    }
    if (request.outcome !== "response" && request.outcome !== "error") {
        throw new TypeError("provider request accounting.outcome must be response or error");
    }
    if (request.status !== undefined
        && (!Number.isInteger(request.status) || (request.status as number) < 100 || (request.status as number) > 599)) {
        throw new TypeError("provider request accounting.status must be an HTTP status");
    }
    if (request.usage !== undefined) validateProviderUsage(request.usage as ProviderUsage);
    validateProviderCost(request.cost);
    return value as ProviderRequestAccounting;
};

const sumKnown = (
    requests: readonly ProviderRequestAccounting[],
    read: (usage: ProviderUsage) => number | undefined,
): number | undefined => {
    const values = requests.map((request) => request.usage === undefined
        ? undefined
        : read(request.usage));
    return values.some((value) => value === undefined)
        ? undefined
        : (values as number[]).reduce((sum, value) => sum + value, 0);
};

export const aggregateProviderAccounting = (
    values: readonly ProviderRequestAccounting[],
): ProviderAccounting => {
    const requests = values.map(validateProviderRequestAccounting);
    if (requests.length === 0) {
        return {
            requests: [],
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                inputTokenDetails: {
                    noCacheTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
                outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
            },
            costUsd: "0",
        };
    }

    const inputTokens = sumKnown(requests, (usage) => usage.inputTokens);
    const outputTokens = sumKnown(requests, (usage) => usage.outputTokens);
    const totalTokens = sumKnown(requests, (usage) => usage.totalTokens);
    const noCacheTokens = sumKnown(requests, (usage) => usage.inputTokenDetails?.noCacheTokens);
    const cacheReadTokens = sumKnown(requests, (usage) => usage.inputTokenDetails?.cacheReadTokens);
    const cacheWriteTokens = sumKnown(requests, (usage) => usage.inputTokenDetails?.cacheWriteTokens);
    const textTokens = sumKnown(requests, (usage) => usage.outputTokenDetails?.textTokens);
    const reasoningTokens = sumKnown(requests, (usage) => usage.outputTokenDetails?.reasoningTokens);
    const inputTokenDetails = noCacheTokens === undefined
        && cacheReadTokens === undefined && cacheWriteTokens === undefined
        ? undefined
        : { noCacheTokens, cacheReadTokens, cacheWriteTokens };
    const outputTokenDetails = textTokens === undefined && reasoningTokens === undefined
        ? undefined
        : { textTokens, reasoningTokens };
    const usage = inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
        && inputTokenDetails === undefined && outputTokenDetails === undefined
        ? null
        : validateProviderUsage({
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(inputTokenDetails === undefined ? {} : { inputTokenDetails }),
            ...(outputTokenDetails === undefined ? {} : { outputTokenDetails }),
        });
    return {
        requests: [...requests],
        usage,
        costUsd: sumProviderCostsUsd(requests.map(({ cost }) => cost)),
    };
};
