import type {
    ProviderAccounting,
    ProviderCostNormalizer,
    ProviderRequestAccounting,
    ProviderUsage,
} from "./types.ts";
import {
    addDecimals,
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

const sumKnown = (
    requests: readonly ProviderRequestAccounting[],
    read: (usage: ProviderUsage) => number | undefined,
): number | undefined => {
    // {§tokenomics-provider-usage} — aggregate usage sums every reported
    // quantity; an unreported one (a response-less failure) is skipped, never
    // invented as zero and never allowed to erase the reported evidence.
    const known = requests
        .map((request) => request.usage === undefined ? undefined : read(request.usage))
        .filter((value): value is number => value !== undefined);
    if (known.length === 0) return undefined;
    const sum = known.reduce((total, value) => total + value, 0);
    if (!Number.isSafeInteger(sum)) {
        throw new TypeError("aggregate provider usage exceeds the safe-integer range");
    }
    return sum;
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
    // Each physical request was validated above. Aggregate fields deliberately
    // sum their own known evidence independently: heterogeneous providers may
    // report different detail subsets, so the projection must not reinterpret
    // their union as one complete per-request partition.
    const usage: ProviderUsage | null = inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
        && inputTokenDetails === undefined && outputTokenDetails === undefined
        ? null
        : {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(inputTokenDetails === undefined ? {} : { inputTokenDetails }),
            ...(outputTokenDetails === undefined ? {} : { outputTokenDetails }),
        };
    return {
        requests: [...requests],
        usage,
        costUsd: sumProviderCostsUsd(requests.map(({ cost }) => cost)),
    };
};
