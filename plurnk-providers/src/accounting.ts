import type {
    ProviderAccounting,
    ProviderCostNormalizer,
    ProviderRequestAccounting,
    ProviderUsage,
} from "./types.ts";
import {
    addDecimals,
    providerCostUsd,
    sumProviderCostsUsd,
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

const openRouterCost: ProviderCostNormalizer = ({ usage }) => {
    // {§provider-monetary-evidence} The SDK metadata omits is_byok; wire usage
    // distinguishes a router fee from a charge that already includes inference.
    const wire = recordOf(usage);
    if (wire === null) return undefined;
    const cost = wire.cost;
    const byok = wire.is_byok;
    if (byok !== true && cost == null && wire.cost_details == null) return undefined;
    if (byok == null) {
        return { kind: "unknown", reason: "OpenRouter usage.is_byok is missing; total request cost is unknown" };
    }
    if (typeof byok !== "boolean") throw new TypeError("OpenRouter usage.is_byok must be boolean");
    if (cost == null) {
        return { kind: "unknown", reason: `OpenRouter${byok ? " BYOK" : ""} usage.cost is missing` };
    }
    if (typeof cost !== "number") throw new TypeError("OpenRouter usage.cost must be numeric");
    const routerCost = decimalFromNumber(cost, "OpenRouter usage.cost");
    if (!byok) {
        return {
            kind: "charged",
            amount: { amount: routerCost, currency: "USD" },
            source: "OpenRouter response usage.cost",
        };
    }
    const upstream = recordOf(wire.cost_details)?.upstream_inference_cost;
    if (upstream == null) {
        return { kind: "unknown", reason: "OpenRouter BYOK usage.cost_details.upstream_inference_cost is missing" };
    }
    if (typeof upstream !== "number") {
        throw new TypeError("OpenRouter usage.cost_details.upstream_inference_cost must be numeric");
    }
    return {
        kind: "charged",
        amount: {
            amount: addDecimals([routerCost, decimalFromNumber(upstream, "OpenRouter usage.cost_details.upstream_inference_cost")]),
            currency: "USD",
        },
        source: "OpenRouter response usage.cost + usage.cost_details.upstream_inference_cost (BYOK)",
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

export const providerCostNormalizer = (
    sdkPackage: string,
): ProviderCostNormalizer | undefined => {
    switch (sdkPackage) {
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

const projectUsage = (
    requests: readonly ProviderRequestAccounting[],
    complete: boolean,
): ProviderUsage | null => {
    if (requests.length === 0) {
        return {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: {
                noCacheTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        };
    }
    const sum = (read: (usage: ProviderUsage) => number | undefined): number | undefined => {
        const known = requests.map(({ usage }) => usage === undefined ? undefined : read(usage))
            .filter((value): value is number => value !== undefined);
        if (known.length === 0 || (complete && known.length !== requests.length)) return undefined;
        const total = known.reduce((a, b) => a + b, 0);
        if (!Number.isSafeInteger(total)) throw new TypeError("aggregate provider usage exceeds the safe-integer range");
        return total;
    };
    const inputTokens = sum((usage) => usage.inputTokens);
    const outputTokens = sum((usage) => usage.outputTokens);
    const totalTokens = sum((usage) => usage.totalTokens);
    const noCacheTokens = sum((usage) => usage.inputTokenDetails?.noCacheTokens);
    const cacheReadTokens = sum((usage) => usage.inputTokenDetails?.cacheReadTokens);
    const cacheWriteTokens = sum((usage) => usage.inputTokenDetails?.cacheWriteTokens);
    const textTokens = sum((usage) => usage.outputTokenDetails?.textTokens);
    const reasoningTokens = sum((usage) => usage.outputTokenDetails?.reasoningTokens);
    const inputTokenDetails = noCacheTokens === undefined
        && cacheReadTokens === undefined && cacheWriteTokens === undefined
        ? undefined
        : {
            ...(noCacheTokens === undefined ? {} : { noCacheTokens }),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        };
    const outputTokenDetails = textTokens === undefined && reasoningTokens === undefined
        ? undefined
        : {
            ...(textTokens === undefined ? {} : { textTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        };
    return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
        && inputTokenDetails === undefined && outputTokenDetails === undefined
        ? null
        : {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(inputTokenDetails === undefined ? {} : { inputTokenDetails }),
            ...(outputTokenDetails === undefined ? {} : { outputTokenDetails }),
        };
};

export const aggregateProviderAccounting = (
    values: readonly ProviderRequestAccounting[],
): ProviderAccounting => {
    const requests = values.map(validateProviderRequestAccounting);
    const costs = requests.map(({ cost }) => cost);
    const knownCosts = costs.map(providerCostUsd).filter((cost): cost is string => cost !== null);
    return {
        requests,
        usage: projectUsage(requests, true),
        knownUsage: projectUsage(requests, false),
        costUsd: sumProviderCostsUsd(costs),
        knownCostUsd: requests.length === 0 ? "0" : knownCosts.length === 0 ? null : addDecimals(knownCosts),
    };
};
