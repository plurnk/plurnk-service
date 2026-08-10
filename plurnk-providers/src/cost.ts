import type {
    AuthoritativeCharge,
    ProviderUsage,
} from "./types.ts";
import type { ProviderCost } from "@plurnk/plurnk-contracts";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;

const nonEmpty = (value: string, name: string): string => {
    if (value.trim() === "") throw new TypeError(`${name} must be non-empty`);
    return value;
};

const decimal = (value: string, name: string): string => {
    if (!DECIMAL.test(value)) throw new TypeError(`${name} must be a canonical non-negative decimal string`);
    return value;
};

export const validateAuthoritativeCharge = (charge: AuthoritativeCharge): AuthoritativeCharge => {
    if (charge.kind !== "authoritative") throw new TypeError("provider charge must be authoritative");
    decimal(charge.amount.amount, "provider charge amount");
    if (!CURRENCY.test(charge.amount.currency)) {
        throw new TypeError("provider charge currency must be an uppercase currency code");
    }
    decimal(charge.usdEquivalent, "provider charge USD equivalent");
    nonEmpty(charge.source, "provider charge source");
    return charge;
};

export const validateProviderCost = (cost: ProviderCost): ProviderCost => {
    switch (cost.kind) {
        case "authoritative":
            return validateAuthoritativeCharge(cost);
        case "estimated":
            decimal(cost.usd, "provider cost estimate");
            nonEmpty(cost.source, "provider cost estimate source");
            return cost;
        case "free":
            nonEmpty(cost.source, "provider free source");
            return cost;
        case "unknown":
            nonEmpty(cost.reason, "provider unknown-cost reason");
            return cost;
    }
};

export const resolveProviderCost = (
    charge: AuthoritativeCharge | undefined,
    current: ProviderCost | undefined,
): ProviderCost => {
    if (charge !== undefined) return validateAuthoritativeCharge(charge);
    if (current !== undefined) return validateProviderCost(current);
    return {
        kind: "unknown",
        reason: "the response reported no cost and Models.dev has no rate for this model",
    };
};

export const providerCostUsd = (cost: ProviderCost): number | null => {
    const value = cost.kind === "authoritative"
        ? cost.usdEquivalent
        : cost.kind === "estimated"
            ? cost.usd
            : cost.kind === "free"
                ? "0"
                : null;
    return value === null ? null : Number(value);
};

export const providerCostFor = (
    provider: { calculateCharge?(usage: ProviderUsage): Exclude<ProviderCost, AuthoritativeCharge>; calculateCost(usage: ProviderUsage): number },
    usage: ProviderUsage,
    charge?: AuthoritativeCharge,
): ProviderCost => resolveProviderCost(
    charge,
    provider.calculateCharge?.(usage),
);
