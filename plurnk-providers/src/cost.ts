import type {
    AuthoritativeCharge,
    ProviderAccountingResult,
    ProviderUsage,
} from "./types.ts";
import type { ProviderCost } from "@plurnk/plurnk-contracts";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;

const recordOf = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

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

export const validateProviderAccountingResult = (value: unknown): ProviderAccountingResult => {
    const result = recordOf(value);
    if (result?.status === "settled") {
        if (typeof result.evaluatedAt !== "string" || !Number.isFinite(Date.parse(result.evaluatedAt))) {
            throw new TypeError("provider accounting settlement has no valid evaluation time");
        }
        return {
            status: "settled",
            charge: validateAuthoritativeCharge(result.charge as AuthoritativeCharge),
            evaluatedAt: result.evaluatedAt,
        };
    }
    if (result?.status === "pending") {
        if (typeof result.reason !== "string" || result.reason.trim().length === 0) {
            throw new TypeError("provider pending accounting has no reason");
        }
        if (result.evaluatedAt !== undefined
            && (typeof result.evaluatedAt !== "string" || !Number.isFinite(Date.parse(result.evaluatedAt)))) {
            throw new TypeError("provider pending accounting has an invalid evaluation time");
        }
        return {
            status: "pending",
            reason: result.reason,
            ...(result.evaluatedAt === undefined ? {} : { evaluatedAt: result.evaluatedAt }),
        };
    }
    throw new TypeError("provider accounting result must be settled or pending");
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
    legacy: () => number,
): ProviderCost => {
    if (charge !== undefined) return validateAuthoritativeCharge(charge);
    if (current !== undefined) return validateProviderCost(current);
    const cost = legacy();
    if (!Number.isFinite(cost) || cost < 0) {
        throw new TypeError("legacy provider cost must be a finite non-negative number");
    }
    return cost > 0
        ? { kind: "estimated", usd: String(cost), source: "legacy calculateCost" }
        : { kind: "unknown", reason: "legacy calculateCost returned zero without free-cost authority" };
};

export const providerCostUsd = (cost: ProviderCost): number | null => {
    const value = cost.kind === "authoritative"
        ? cost.usdEquivalent
        : cost.kind === "free"
            ? "0"
            : null;
    return value === null ? null : Number(value);
};

export const providerProjectedCostUsd = (cost: ProviderCost): number | null => {
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
    () => provider.calculateCost(usage),
);
