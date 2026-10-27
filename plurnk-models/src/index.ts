// Release-time Models.dev snapshot with explicit on-demand XDG cache overlay ({§model-catalog-cache}).
// This package owns lookup; provider-owned field precedence is defined by {§model-fact-resolution}.

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import catalog from "./catalog.json" with { type: "json" };
import providers from "./providers.json" with { type: "json" };
import { isProviderAdapter, projectCatalog, PROVIDER_ADAPTERS } from "./project.ts";
import type { ProviderAdapter } from "./project.ts";

export { isProviderAdapter, projectCatalog, PROVIDER_ADAPTERS };
export type { ProviderAdapter };

export type ModelCost = {
    readonly inputPer1M: number;        // USD per 1M input tokens
    readonly outputPer1M: number;       // USD per 1M output tokens
    readonly reasoningPer1M?: number;
    readonly cacheReadPer1M?: number;
    readonly cacheWritePer1M?: number;
};

export type ModelEffort =
    | null
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "default";

export type ModelReasoningOption =
    | { readonly type: "toggle" }
    | { readonly type: "effort"; readonly values: readonly ModelEffort[] }
    | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };

type ModelInfoBase = {
    readonly name: string;
    readonly contextWindow: number;     // tokens
    readonly maxInputTokens?: number;   // independent input cap; absent when the source had none
    readonly maxOutputTokens?: number;  // independent total-output cap; absent when the source had none
    readonly attachment: boolean;
    readonly toolCall: boolean;
    readonly structuredOutput?: boolean;
    readonly temperature?: boolean;
    readonly modalities: {
        readonly input: readonly string[];
        readonly output: readonly string[];
    };
    readonly cost?: ModelCost;          // absent without complete input and output rates
};

export type ModelInfo = ModelInfoBase & (
    | {
        readonly reasoning: true;
        readonly reasoningOptions: readonly ModelReasoningOption[];
    }
    | {
        readonly reasoning: false;
        readonly reasoningOptions?: never;
    }
);

export type ProviderInfo = {
    readonly id: string;
    readonly name: string;
    readonly adapter: string;
    readonly env: readonly string[];
    readonly api?: string;
};

export type CatalogUpdateReport = {
    readonly status: "updated" | "unchanged";
    readonly providers: number;
    readonly models: number;
    readonly addedModels: number;
    readonly updatedAt: string;
    readonly path: string;
};

type CachedCatalogFile = {
    readonly updatedAt: string;
    readonly etag?: string;
    readonly catalog: Record<string, Record<string, ModelInfo>>;
    readonly providers: Record<string, ProviderInfo>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the catalog is generated into this shape from the Models.dev snapshot
const shippedCatalog = catalog as Record<string, Record<string, ModelInfo>>;
const shippedProviders = providers as Record<string, ProviderInfo>;

let activeCatalog: Record<string, Record<string, ModelInfo>> = shippedCatalog;
let activeProviders: Record<string, ProviderInfo> = shippedProviders;

const shippedMtimeMs = (): number => {
    try {
        return statSync(fileURLToPath(new URL("./catalog.json", import.meta.url))).mtimeMs;
    } catch {
        return 0;
    }
};

const mergeCatalogs = (
    primaryCatalog: Record<string, Record<string, ModelInfo>>,
    primaryProviders: Record<string, ProviderInfo>,
    secondaryCatalog: Record<string, Record<string, ModelInfo>>,
    secondaryProviders: Record<string, ProviderInfo>,
): {
    readonly catalog: Record<string, Record<string, ModelInfo>>;
    readonly providers: Record<string, ProviderInfo>;
} => {
    const mergedProviders: Record<string, ProviderInfo> = {
        ...secondaryProviders,
        ...primaryProviders,
    };
    const mergedCatalog: Record<string, Record<string, ModelInfo>> = {};
    const providerIds = new Set([...Object.keys(secondaryCatalog), ...Object.keys(primaryCatalog)]);
    for (const id of providerIds) {
        mergedCatalog[id] = {
            ...secondaryCatalog[id],
            ...primaryCatalog[id],
        };
    }
    return { catalog: mergedCatalog, providers: mergedProviders };
};

const parseCachedCatalog = (raw: string): CachedCatalogFile | null => {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || typeof parsed.updatedAt !== "string") return null;
        if (!isRecord(parsed.catalog) || !isRecord(parsed.providers)) return null;
        for (const entry of Object.values(parsed.providers)) {
            if (!isRecord(entry) || typeof entry.adapter !== "string" || !isProviderAdapter(entry.adapter)) {
                return null;
            }
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by updateCatalogCache from projectCatalog
        const cachedCatalog = parsed.catalog as Record<string, Record<string, ModelInfo>>;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by updateCatalogCache from projectCatalog
        const cachedProviders = parsed.providers as Record<string, ProviderInfo>;
        return {
            updatedAt: parsed.updatedAt,
            ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
            catalog: cachedCatalog,
            providers: cachedProviders,
        };
    } catch {
        return null;
    }
};

const countModels = (cat: Record<string, Record<string, ModelInfo>>): number =>
    Object.values(cat).reduce((sum, entries) => sum + Object.keys(entries).length, 0);

// {§model-catalog-cache} Load an existing XDG catalog cache without network access.
// Whichever source (cached or shipped) has the newer timestamp takes precedence on overlap.
export const loadCatalogCache = (cachePath: string): boolean => {
    if (!existsSync(cachePath)) return false;
    let raw: string;
    try {
        raw = readFileSync(cachePath, "utf8");
    } catch {
        return false;
    }
    const cached = parseCachedCatalog(raw);
    if (cached === null) return false;
    const cacheTime = Date.parse(cached.updatedAt);
    const cacheIsNewer = Number.isFinite(cacheTime) && cacheTime >= shippedMtimeMs();
    const merged = cacheIsNewer
        ? mergeCatalogs(cached.catalog, cached.providers, shippedCatalog, shippedProviders)
        : mergeCatalogs(shippedCatalog, shippedProviders, cached.catalog, cached.providers);
    activeCatalog = merged.catalog;
    activeProviders = merged.providers;
    return true;
};

// {§model-catalog-cache} Explicitly fetch Models.dev (`https://models.dev/api.json`), project and
// persist it to `cachePath`, and hot-swap the active in-memory catalog immediately.
export const updateCatalogCache = async (
    cachePath: string,
    options: {
        readonly url?: string;
        readonly fetch?: typeof globalThis.fetch;
        readonly signal?: AbortSignal;
    } = {},
): Promise<CatalogUpdateReport> => {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const url = options.url ?? "https://models.dev/api.json";
    let existing: CachedCatalogFile | null = null;
    if (existsSync(cachePath)) {
        try {
            existing = parseCachedCatalog(await readFile(cachePath, "utf8"));
        } catch {
            existing = null;
        }
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (existing?.etag !== undefined) {
        headers["if-none-match"] = existing.etag;
    }

    const response = await fetchFn(url, {
        method: "GET",
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.status === 304 && existing !== null) {
        const merged = mergeCatalogs(existing.catalog, existing.providers, shippedCatalog, shippedProviders);
        activeCatalog = merged.catalog;
        activeProviders = merged.providers;
        return {
            status: "unchanged",
            providers: Object.keys(activeCatalog).length,
            models: countModels(activeCatalog),
            addedModels: 0,
            updatedAt: existing.updatedAt,
            path: cachePath,
        };
    }

    if (!response.ok) {
        throw new Error(`Models.dev catalog request failed with HTTP ${response.status}`);
    }

    const rawBody: unknown = await response.json();
    const projected = projectCatalog(rawBody);
    const previousCatalog = activeCatalog;
    let addedModels = 0;
    for (const [providerId, models] of Object.entries(projected.catalog)) {
        const prevModels = previousCatalog[providerId] ?? {};
        for (const modelId of Object.keys(models)) {
            if (!Object.hasOwn(prevModels, modelId)) addedModels += 1;
        }
    }

    const updatedAt = new Date().toISOString();
    const etag = response.headers.get("etag") ?? undefined;
    const payload: CachedCatalogFile = {
        updatedAt,
        ...(etag === undefined ? {} : { etag }),
        catalog: projected.catalog,
        providers: projected.providers,
    };

    await mkdir(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tmpPath, cachePath);

    const merged = mergeCatalogs(projected.catalog, projected.providers, shippedCatalog, shippedProviders);
    activeCatalog = merged.catalog;
    activeProviders = merged.providers;

    return {
        status: "updated",
        providers: Object.keys(activeCatalog).length,
        models: countModels(activeCatalog),
        addedModels,
        updatedAt,
        path: cachePath,
    };
};

export const resetCatalog = (): void => {
    activeCatalog = shippedCatalog;
    activeProviders = shippedProviders;
};

// Snapshot lookup only; {§model-fact-resolution} owns field-specific runtime
// precedence. `provider` is the PLURNK alias-cascade segment and `model` is the
// provider-native id (for relays, `publisher/model`).
export const lookup = (provider: string, model: string): ModelInfo | null =>
    activeCatalog[provider]?.[model] ?? null;

export const resolveModel = (
    provider: string,
    model: string,
): { readonly id: string; readonly info: ModelInfo } | null => {
    const models = activeCatalog[provider];
    if (models === undefined) return null;
    const exact = models[model];
    if (exact !== undefined) return { id: model, info: exact };
    const suffix = `/${model}`;
    const matches = Object.entries(models).filter(([candidate]) => candidate.endsWith(suffix));
    return matches.length === 1
        ? { id: matches[0][0], info: matches[0][1] }
        : null;
};

export const lookupProvider = (provider: string): ProviderInfo | null =>
    activeProviders[provider] ?? null;

// The raw snapshot, for a consumer that wants to enumerate (e.g. a client's
// model picker). Read-only; do not mutate.
export const catalogSnapshot = (): Readonly<Record<string, Readonly<Record<string, ModelInfo>>>> => activeCatalog;

// (#459) The route segment IS the Models.dev id; the mapping is identity.
export const providerNameFromCatalogId = (id: string): string => id;

export const providerCatalogSnapshot = (): Readonly<Record<string, ProviderInfo>> => activeProviders;

// models.dev's `env` mixes credentials with non-secret endpoint coordinates
// such as AWS_REGION and CLOUDFLARE_ACCOUNT_ID. Only conventional credential
// names are credentials; a coordinate is never one.
export const isProviderCredentialName = (name: string): boolean =>
    /(?:API_KEY|TOKEN|SECRET|ACCESS_KEY_ID|PASSWORD|CREDENTIAL)/.test(name);

export const providerCredentialEnvNames = (): readonly string[] =>
    [...new Set(Object.values(activeProviders)
        .flatMap((provider) => provider.env)
        .filter(isProviderCredentialName))]
        .toSorted();
