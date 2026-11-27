// Release-time Models.dev SQLite snapshot with explicit on-demand XDG cache overlay ({§model-catalog-cache}).
// Backed by @possumtech/sqlrite/sync so importing this package retains zero full-catalog JS heap (#1576).
// This package owns lookup; provider-owned field precedence is defined by {§model-fact-resolution}.

import { statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isProviderAdapter, projectCatalog, PROVIDER_ADAPTERS } from "./project.ts";
import type { ProviderAdapter } from "./project.ts";
import {
    SHIPPED_CATALOG_DB_PATH,
    openOverlayCatalog,
    openReadOnlyCatalog,
    rowToModelInfo,
    rowToProviderInfo,
    validateCachedCatalogDb,
    writeCatalogDatabase,
    type CatalogStore,
} from "./store.ts";

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

export type CatalogModelSort = "selector" | "cost-asc" | "cost-desc" | "context-desc";

export type CatalogModelQuery = {
    readonly providers: readonly string[];
    readonly search?: string;
    readonly minInputPer1M?: number;
    readonly maxInputPer1M?: number;
    readonly sort?: CatalogModelSort;
    readonly offset: number;
    readonly limit: number;
};

export type CatalogModelRecord = {
    readonly provider: ProviderInfo;
    readonly id: string;
    readonly info: ModelInfo;
};

export type CatalogModelQueryResult = {
    readonly items: readonly CatalogModelRecord[];
    readonly total: number;
};

// Lazily opened read-only SqlRite handle (shipped catalog.db, or ATTACH overlay with models.db).
let activeDb: CatalogStore | null = null;

const closeActiveDb = (): void => {
    if (activeDb === null) return;
    try {
        activeDb.close();
    } finally {
        activeDb = null;
    }
};

const getActiveDb = (): CatalogStore => {
    activeDb ??= openReadOnlyCatalog(SHIPPED_CATALOG_DB_PATH);
    return activeDb;
};

const shippedMtimeMs = (): number => {
    try {
        return statSync(SHIPPED_CATALOG_DB_PATH).mtimeMs;
    } catch {
        return 0;
    }
};

const activateCacheOverlay = (cachePath: string, cacheIsNewer: boolean): void => {
    const next = cacheIsNewer
        ? openOverlayCatalog(cachePath, SHIPPED_CATALOG_DB_PATH)
        : openOverlayCatalog(SHIPPED_CATALOG_DB_PATH, cachePath);
    closeActiveDb();
    activeDb = next;
};

// {§model-catalog-cache} Load an existing XDG SQLite catalog cache without network access.
// Whichever source (cached or shipped) has the newer timestamp takes precedence on overlap.
export const loadCatalogCache = (cachePath: string): boolean => {
    const meta = validateCachedCatalogDb(cachePath);
    if (meta === null) return false;
    const cacheTime = Date.parse(meta.updatedAt);
    const cacheIsNewer = Number.isFinite(cacheTime) && cacheTime >= shippedMtimeMs();
    try {
        activateCacheOverlay(cachePath, cacheIsNewer);
        return true;
    } catch {
        return false;
    }
};

// {§model-catalog-cache} Explicitly fetch Models.dev (`https://models.dev/api.json`), project and
// persist it atomically to `cachePath` (`models.db`), and hot-swap the active SQLite overlay.
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
    const existing = validateCachedCatalogDb(cachePath);

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
        activateCacheOverlay(cachePath, true);
        const db = getActiveDb();
        return {
            status: "unchanged",
            providers: db.countProviders(),
            models: db.countModels(),
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
    const prevDb = getActiveDb();
    let addedModels = 0;
    for (const [providerId, models] of Object.entries(projected.catalog)) {
        for (const modelId of Object.keys(models)) {
            if (prevDb.lookupModel(providerId, modelId) === undefined) {
                addedModels += 1;
            }
        }
    }

    const updatedAt = new Date().toISOString();
    const etag = response.headers.get("etag") ?? undefined;

    await mkdir(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeCatalogDatabase(tmpPath, projected, {
            updatedAt,
            ...(etag === undefined ? {} : { etag }),
        });
        await rename(tmpPath, cachePath);
    } catch (cause) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw cause;
    }

    activateCacheOverlay(cachePath, true);
    const db = getActiveDb();

    return {
        status: "updated",
        providers: db.countProviders(),
        models: db.countModels(),
        addedModels,
        updatedAt,
        path: cachePath,
    };
};

export const resetCatalog = (): void => {
    closeActiveDb();
};

// Snapshot lookup only; {§model-fact-resolution} owns field-specific runtime
// precedence. `provider` is the PLURNK alias-cascade segment and `model` is the
// provider-native id (for relays, `publisher/model`).
export const lookup = (provider: string, model: string): ModelInfo | null => {
    const row = getActiveDb().lookupModel(provider, model);
    return row === undefined ? null : rowToModelInfo(row);
};

export const resolveModel = (
    provider: string,
    model: string,
): { readonly id: string; readonly info: ModelInfo } | null => {
    const db = getActiveDb();
    const exact = db.lookupModel(provider, model);
    if (exact !== undefined) return { id: model, info: rowToModelInfo(exact) };
    const matches = model.includes("/")
        ? db.resolvePathSuffix(provider, `/${model}`)
        : db.resolveLeafSuffix(provider, model);
    return matches.length === 1
        ? { id: matches[0].id, info: rowToModelInfo(matches[0]) }
        : null;
};

export const lookupProvider = (provider: string): ProviderInfo | null => {
    const row = getActiveDb().lookupProvider(provider);
    return row === undefined ? null : rowToProviderInfo(row);
};

export const listProviders = (): readonly ProviderInfo[] =>
    getActiveDb().listProviders().map(rowToProviderInfo);

export const listCatalogProviders = (): readonly ProviderInfo[] =>
    getActiveDb().listPopulatedProviders().map(rowToProviderInfo);

// {§model-catalog-projection} Indexed SQLite pagination and substring search without
// materializing the full catalog in Node heap (#1576).
export const queryCatalog = (query: CatalogModelQuery): CatalogModelQueryResult => {
    if (query.providers.length === 0) return { items: [], total: 0 };
    const db = getActiveDb();
    const providersJson = JSON.stringify(query.providers);
    const search = query.search?.trim().toLowerCase() ?? "";
    const minInputCost = query.minInputPer1M ?? null;
    const maxInputCost = query.maxInputPer1M ?? null;
    const sort: CatalogModelSort = query.sort ?? "selector";
    const total = db.queryModelsCount(providersJson, search, minInputCost, maxInputCost);
    if (total === 0 || query.limit <= 0 || query.offset >= total) {
        return { items: [], total };
    }
    const rows = db.queryModels(providersJson, search, minInputCost, maxInputCost, sort, query.limit, query.offset);
    return {
        items: rows.map((row) => ({
            provider: rowToProviderInfo({
                id: row.provider_id,
                name: row.provider_name,
                adapter: row.provider_adapter,
                env: row.provider_env,
                api: row.provider_api,
            }),
            id: row.id,
            info: rowToModelInfo(row),
        })),
        total,
    };
};

// Materializes a read-only snapshot on demand for diagnostic tools and tests.
// Production model discovery uses indexed `listProviders()` + `queryCatalog()` instead.
export const catalogSnapshot = (): Readonly<Record<string, Readonly<Record<string, ModelInfo>>>> => {
    const out: Record<string, Record<string, ModelInfo>> = {};
    for (const row of getActiveDb().listModels()) {
        (out[row.provider_id] ??= {})[row.id] = rowToModelInfo(row);
    }
    return out;
};

// (#459) The route segment IS the Models.dev id; the mapping is identity.
export const providerNameFromCatalogId = (id: string): string => id;

export const providerCatalogSnapshot = (): Readonly<Record<string, ProviderInfo>> => {
    const out: Record<string, ProviderInfo> = {};
    for (const row of getActiveDb().listProviders()) {
        out[row.id] = rowToProviderInfo(row);
    }
    return out;
};

// models.dev's `env` mixes credentials with non-secret endpoint coordinates
// such as AWS_REGION and CLOUDFLARE_ACCOUNT_ID. Only conventional credential
// names are credentials; a coordinate is never one.
export const isProviderCredentialName = (name: string): boolean =>
    /(?:API_KEY|TOKEN|SECRET|ACCESS_KEY_ID|PASSWORD|CREDENTIAL)/.test(name);

export const providerCredentialEnvNames = (): readonly string[] => {
    const names = new Set<string>();
    for (const row of getActiveDb().listProviderEnvs()) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- env is JSON-serialized string[]
        for (const name of JSON.parse(row.env) as readonly string[]) {
            if (isProviderCredentialName(name)) names.add(name);
        }
    }
    return [...names].toSorted();
};
