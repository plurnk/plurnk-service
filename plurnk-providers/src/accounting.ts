import type {
    AuthoritativeChargeNormalizer,
} from "./types.ts";

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

const xaiCharge: AuthoritativeChargeNormalizer = ({ usage }) => {
    const wireUsage = recordOf(usage);
    if (wireUsage === null || !("cost_in_usd_ticks" in wireUsage)) return undefined;
    const ticks = wireUsage.cost_in_usd_ticks;
    if (typeof ticks !== "number") {
        throw new TypeError("xAI usage.cost_in_usd_ticks must be numeric");
    }
    return {
        kind: "authoritative",
        amount: { amount: String(ticks), currency: "USDTICK" },
        usdEquivalent: usdFromTicks(ticks),
        source: "xAI response usage.cost_in_usd_ticks",
    };
};

const openRouterCharge: AuthoritativeChargeNormalizer = ({ providerMetadata }) => {
    const usage = recordOf(recordOf(recordOf(providerMetadata)?.openrouter)?.usage);
    if (usage === null || !("cost" in usage)) return undefined;
    const cost = usage.cost;
    if (typeof cost !== "number") throw new TypeError("OpenRouter usage.cost must be numeric");
    const amount = decimalFromNumber(cost, "OpenRouter usage.cost");
    return {
        kind: "authoritative",
        amount: { amount, currency: "USD" },
        usdEquivalent: amount,
        source: "OpenRouter response usage.cost",
    };
};

export const authoritativeChargeNormalizer = (
    sdkPackage: string,
): AuthoritativeChargeNormalizer | undefined => {
    switch (sdkPackage) {
        case "@ai-sdk/xai": return xaiCharge;
        case "@openrouter/ai-sdk-provider": return openRouterCharge;
        default: return undefined;
    }
};
