import { setTimeout as delay } from "node:timers/promises";
import type {
    AuthoritativeChargeNormalizer,
    ProviderAccountingAdapter,
    ProviderAccountingResult,
    ProviderAccountingScope,
    ProviderCallAccounting,
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

type FireworksAccountingConfig = {
    apiKey: string;
    accountId?: string;
    timeoutMs: number;
    pollIntervalMs: number;
    fetch?: typeof globalThis.fetch;
};

type FireworksUsageSnapshot = {
    amount: string;
    evaluatedAt: string;
    completeness: "COMPLETE" | "INCOMPLETE";
};

const accountIdOf = (name: string): string => {
    const id = name.startsWith("accounts/") ? name.slice("accounts/".length) : name;
    if (id.length === 0 || id.includes("/")) {
        throw new TypeError(`Fireworks account name is invalid: ${name}`);
    }
    return id;
};

const decimalFromMoney = (value: unknown): string => {
    const money = recordOf(value);
    const units = money?.units ?? "0";
    const nanos = money?.nanos ?? 0;
    if (money?.currencyCode !== "USD") {
        throw new TypeError("Fireworks usage subtotal must be denominated in USD");
    }
    if (typeof units !== "string" || !/^\d+$/.test(units)) {
        throw new TypeError("Fireworks usage subtotal units must be a non-negative integer string");
    }
    if (!Number.isInteger(nanos) || (nanos as number) < 0 || (nanos as number) > 999_999_999) {
        throw new TypeError("Fireworks usage subtotal nanos must be a non-negative integer below one billion");
    }
    const integer = units.replace(/^0+(?=\d)/, "");
    const fraction = String(nanos).padStart(9, "0").replace(/0+$/, "");
    return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

class FireworksAccounting implements ProviderAccountingAdapter {
    #apiKey: string;
    #configuredAccountId: string | undefined;
    #timeoutMs: number;
    #pollIntervalMs: number;
    #fetch: typeof globalThis.fetch;
    #resolvedAccountId?: Promise<string>;

    constructor(config: FireworksAccountingConfig) {
        if (config.apiKey.length === 0) throw new TypeError("Fireworks accounting requires an API key");
        if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 0) {
            throw new TypeError("Fireworks accounting timeout must be a non-negative integer");
        }
        if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 1) {
            throw new TypeError("Fireworks accounting poll interval must be a positive integer");
        }
        this.#apiKey = config.apiKey;
        this.#configuredAccountId = config.accountId;
        this.#timeoutMs = config.timeoutMs;
        this.#pollIntervalMs = config.pollIntervalMs;
        this.#fetch = config.fetch ?? globalThis.fetch;
    }

    headers({ scopeId, callId }: ProviderCallAccounting): Readonly<Record<string, string>> {
        if (scopeId.length === 0) throw new TypeError("Fireworks accounting scope ID must not be empty");
        if (callId.length === 0) throw new TypeError("Fireworks accounting call ID must not be empty");
        return {
            "x-multi-turn-session-id": scopeId,
            "x-session-affinity": scopeId,
        };
    }

    async #json(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
        const response = await this.#fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.#apiKey}`,
                "Content-Type": "application/json",
                ...init.headers,
            },
            ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) {
            const detail = (await response.text()).trim();
            throw new Error(`Fireworks accounting API returned ${response.status}${detail.length === 0 ? "" : `: ${detail.slice(0, 512)}`}`);
        }
        return response.json();
    }

    async #accountId(signal?: AbortSignal): Promise<string> {
        if (this.#configuredAccountId !== undefined && this.#configuredAccountId.length > 0) {
            return accountIdOf(this.#configuredAccountId);
        }
        const resolution = this.#resolvedAccountId ??= (async () => {
            const body = recordOf(await this.#json(
                "https://api.fireworks.ai/v1/accounts?pageSize=200",
                { method: "GET" },
                signal,
            ));
            const accounts = body?.accounts;
            if (!Array.isArray(accounts)) throw new TypeError("Fireworks List Accounts response has no accounts array");
            if (typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0) {
                throw new Error("Fireworks account resolution is ambiguous across multiple pages; set FIREWORKS_ACCOUNT_ID");
            }
            const names = accounts.flatMap((account) => {
                const name = recordOf(account)?.name;
                return typeof name === "string" && name.length > 0 ? [name] : [];
            });
            if (names.length !== 1) {
                throw new Error(`Fireworks account resolution found ${names.length} accounts; set FIREWORKS_ACCOUNT_ID`);
            }
            return accountIdOf(names[0]!);
        })();
        try {
            return await resolution;
        } catch (cause) {
            if (this.#resolvedAccountId === resolution) this.#resolvedAccountId = undefined;
            throw cause;
        }
    }

    async #query(scope: ProviderAccountingScope, signal?: AbortSignal): Promise<FireworksUsageSnapshot> {
        const accountId = await this.#accountId(signal);
        const body = recordOf(await this.#json(
            `https://api.fireworks.ai/v1/accounts/${encodeURIComponent(accountId)}/usageCosts:query`,
            {
                method: "POST",
                body: JSON.stringify({
                    startTime: scope.startedAt,
                    // The API's end is exclusive. Extend the terminal fence by
                    // one millisecond so a request and terminal stamp sharing
                    // SQLite's millisecond timestamp cannot lose the request.
                    endTime: new Date(Date.parse(scope.endedAt) + 1).toISOString(),
                    scope: "SELF",
                    filter: { model: scope.model, sessionId: scope.id }, // lexicon-allow: Fireworks billing wire field
                }),
            },
            signal,
        ));
        const evaluatedAt = body?.evaluationTime;
        if (typeof evaluatedAt !== "string" || !Number.isFinite(Date.parse(evaluatedAt))) {
            throw new TypeError("Fireworks usage-cost response has no valid evaluationTime");
        }
        const completeness = body?.attributionCompleteness;
        if (completeness !== "COMPLETE" && completeness !== "INCOMPLETE") {
            throw new TypeError(`Fireworks usage-cost attribution completeness is ${String(completeness)}`);
        }
        return {
            amount: decimalFromMoney(body?.subtotal),
            evaluatedAt,
            completeness,
        };
    }

    async reconcile(scope: ProviderAccountingScope, signal?: AbortSignal): Promise<ProviderAccountingResult> {
        const start = Date.parse(scope.startedAt);
        const end = Date.parse(scope.endedAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
            throw new TypeError("Fireworks accounting scope has an invalid time range");
        }
        const deadline = Date.now() + this.#timeoutMs;
        let prior: FireworksUsageSnapshot | undefined;
        let latest: FireworksUsageSnapshot | undefined;
        try {
            do {
                latest = await this.#query(scope, signal);
                const evaluatedAfterScope = Date.parse(latest.evaluatedAt) >= end + 1;
                // A response-less failed call can have no observed token usage
                // while still being billable. Only a genuinely empty scope may
                // settle at zero; every issued call waits for provider evidence.
                const attributableSubtotal = scope.attempts === 0 || latest.amount !== "0";
                if (evaluatedAfterScope
                    && attributableSubtotal
                    && latest.completeness === "COMPLETE"
                    && prior?.amount === latest.amount
                    && prior.completeness === "COMPLETE"
                    && Date.parse(prior.evaluatedAt) >= end + 1) {
                    return {
                        status: "settled",
                        charge: {
                            kind: "authoritative",
                            amount: { amount: latest.amount, currency: "USD" },
                            usdEquivalent: latest.amount,
                            source: `Fireworks scoped usageCosts query (SELF, ${latest.completeness})`,
                        },
                        evaluatedAt: latest.evaluatedAt,
                    };
                }
                prior = latest;
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await delay(Math.min(this.#pollIntervalMs, remaining), undefined, { signal });
            } while (true);
        } catch (cause) {
            if (signal?.aborted) throw cause;
            return {
                status: "pending",
                reason: cause instanceof Error ? cause.message : String(cause),
                ...(latest === undefined ? {} : { evaluatedAt: latest.evaluatedAt }),
            };
        }
        const reason = latest === undefined
            ? "Fireworks accounting produced no usage snapshot"
            : latest.completeness !== "COMPLETE"
                ? "Fireworks reported incomplete usage attribution; the excluded amount is unknown"
                : scope.attempts > 0 && latest.amount === "0"
                    ? "Fireworks usage ledger has not attributed the issued model calls"
                    : "Fireworks usage subtotal did not reach two stable post-scope observations before the accounting timeout";
        return {
            status: "pending",
            reason,
            ...(latest === undefined ? {} : { evaluatedAt: latest.evaluatedAt }),
        };
    }
}

export const fireworksAccounting = (config: FireworksAccountingConfig): ProviderAccountingAdapter =>
    new FireworksAccounting(config);

export const authoritativeChargeNormalizer = (
    sdkPackage: string,
): AuthoritativeChargeNormalizer | undefined => {
    switch (sdkPackage) {
        case "@ai-sdk/xai": return xaiCharge;
        case "@openrouter/ai-sdk-provider": return openRouterCharge;
        default: return undefined;
    }
};
