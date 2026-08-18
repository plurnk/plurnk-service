import type {
    ChargedCost,
    ProviderCost,
    ProviderUsage,
} from "./types.ts";
import {
    calculateCostUsdDecimal,
    canonicalDecimal,
    type TokenRates,
} from "./usage.ts";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;

const recordOf = (value: unknown, name: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
};

const nonEmpty = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${name} must be a non-empty string`);
    }
    return value;
};

export const validateDecimal = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new TypeError(`${name} must be a canonical non-negative decimal string`);
    }
    return value;
};

const monetaryAmount = (value: unknown, name: string): { amount: string; currency: string } => {
    const amount = recordOf(value, name);
    const decimalAmount = validateDecimal(amount.amount, `${name} amount`);
    if (typeof amount.currency !== "string" || !CURRENCY.test(amount.currency)) {
        throw new TypeError(`${name} currency must be an uppercase currency code`);
    }
    return { amount: decimalAmount, currency: amount.currency };
};

export const validateChargedCost = (value: unknown): ChargedCost => {
    const cost = recordOf(value, "provider charged cost");
    if (cost.kind !== "charged") throw new TypeError("provider charged cost kind must be charged");
    monetaryAmount(cost.amount, "provider charged cost");
    if (cost.usdEquivalent !== undefined) {
        validateDecimal(cost.usdEquivalent, "provider charged cost USD equivalent");
    }
    nonEmpty(cost.source, "provider charged cost source");
    return value as ChargedCost;
};

export const validateProviderCost = (value: unknown): ProviderCost => {
    const cost = recordOf(value, "provider cost");
    switch (cost.kind) {
        case "charged":
            return validateChargedCost(value);
        case "estimated":
            monetaryAmount(cost.amount, "provider estimated cost");
            nonEmpty(cost.source, "provider estimated cost source");
            return value as ProviderCost;
        case "unknown":
            nonEmpty(cost.reason, "provider unknown-cost reason");
            return value as ProviderCost;
        default:
            throw new TypeError("provider cost kind must be charged, estimated, or unknown");
    }
};

export const estimateProviderCost = (
    usage: ProviderUsage | undefined,
    rates: TokenRates | null,
    source: string,
): ProviderCost => {
    if (usage === undefined) {
        return { kind: "unknown", reason: "the provider response reported no normalized usage" };
    }
    if (rates === null) {
        return { kind: "unknown", reason: "Models.dev has no complete rate for this model" };
    }
    const usd = calculateCostUsdDecimal(usage, rates);
    return usd === null
        ? {
            kind: "unknown",
            reason: "the provider response omitted a token category with a distinct Models.dev rate",
        }
        : {
            kind: "estimated",
            amount: { amount: usd, currency: "USD" },
            source,
        };
};

export const resolveProviderCost = (
    direct: ProviderCost | undefined,
    estimated: ProviderCost,
): ProviderCost => direct === undefined
    ? validateProviderCost(estimated)
    : validateProviderCost(direct);

export const providerCostUsd = (cost: ProviderCost): string | null => {
    const validated = validateProviderCost(cost);
    switch (validated.kind) {
        case "charged":
            return validated.amount.currency === "USD"
                ? validated.amount.amount
                : validated.usdEquivalent ?? null;
        case "estimated":
            return validated.amount.currency === "USD" ? validated.amount.amount : null;
        case "unknown":
            return null;
    }
};

const decimalParts = (value: string): { coefficient: bigint; scale: number } => {
    validateDecimal(value, "decimal amount");
    const [integer, fraction = ""] = value.split(".");
    return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

export const addDecimals = (values: readonly string[]): string => {
    const parts = values.map(decimalParts);
    const scale = Math.max(0, ...parts.map((part) => part.scale));
    const coefficient = parts.reduce(
        (sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale),
        0n,
    );
    return canonicalDecimal(coefficient, scale);
};

export const sumProviderCostsUsd = (costs: readonly ProviderCost[]): string | null => {
    // {§tokenomics-provider-usage} — a request without USD-expressible cost
    // (an uncataloged model, or a response-less failure) is skipped; it never
    // erases the expressible evidence. Null only when nothing is expressible.
    const values = costs.map(providerCostUsd).filter((value): value is string => value !== null);
    return values.length === 0 ? null : addDecimals(values);
};
