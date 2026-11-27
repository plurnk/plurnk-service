// {§model-catalog-build} {§model-catalog-cache} — SqlRite-backed catalog storage, read-only
// inspection, and ATTACH + TEMP VIEW overlay management (#1576).

import SqlRiteSync from "@possumtech/sqlrite/sync";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isProviderAdapter } from "./project.ts";
import type { ModelCost, ModelInfo, ModelReasoningOption, ProviderInfo } from "./index.ts";
import type { SqlRiteOptions, SqlRiteSync as CatalogSqlRite } from "../SqlRite.js";

const CATALOG_SCHEMA_VERSION = "1";

const WRITE_SQL_DIR = fileURLToPath(new URL("./sql/write", import.meta.url));
const READ_SQL_DIR = fileURLToPath(new URL("./sql/read", import.meta.url));
const OVERLAY_SQL_DIR = fileURLToPath(new URL("./sql/overlay", import.meta.url));

export const SHIPPED_CATALOG_DB_PATH = fileURLToPath(new URL("./catalog.db", import.meta.url));

export type ProviderRow = {
    readonly id: string;
    readonly name: string;
    readonly adapter: string;
    readonly env: string;
    readonly api: string | null;
};

export type ModelRow = {
    readonly provider_id: string;
    readonly id: string;
    readonly suffix: string | null;
    readonly name: string;
    readonly context_window: number;
    readonly max_input_tokens: number | null;
    readonly max_output_tokens: number | null;
    readonly attachment: number;
    readonly reasoning: number;
    readonly reasoning_options: string | null;
    readonly tool_call: number;
    readonly structured_output: number | null;
    readonly temperature: number | null;
    readonly modalities_input: string;
    readonly modalities_output: string;
    readonly cost_input: number | null;
    readonly cost_output: number | null;
    readonly cost_reasoning: number | null;
    readonly cost_cache_read: number | null;
    readonly cost_cache_write: number | null;
};

export type QueryModelRow = ModelRow & {
    readonly provider_name: string;
    readonly provider_adapter: string;
    readonly provider_env: string;
    readonly provider_api: string | null;
};

type CatalogReadHandle = Pick<
    CatalogSqlRite,
    | "catalog_get_meta"
    | "catalog_lookup_provider"
    | "catalog_list_providers"
    | "catalog_list_populated_providers"
    | "catalog_list_provider_envs"
    | "catalog_lookup_model"
    | "catalog_resolve_leaf_suffix"
    | "catalog_resolve_path_suffix"
    | "catalog_list_models"
    | "catalog_count_providers"
    | "catalog_count_models"
    | "catalog_query_models"
    | "catalog_query_models_count"
    | "close"
    | typeof Symbol.dispose
>;

type CatalogWriteHandle = Pick<
    CatalogSqlRite,
    | "catalog_begin"
    | "catalog_commit"
    | "catalog_rollback"
    | "catalog_seal"
    | "catalog_put_meta"
    | "catalog_put_provider"
    | "catalog_put_model"
    | "close"
    | typeof Symbol.dispose
>;

const openReadHandle = (options: SqlRiteOptions): CatalogReadHandle =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SqlRiteSync dynamically binds generated SqlRite.d.ts statements from src/sql/read
    new SqlRiteSync(options) as CatalogReadHandle;

const openWriteHandle = (options: SqlRiteOptions): CatalogWriteHandle =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SqlRiteSync dynamically binds generated SqlRite.d.ts statements from src/sql/write
    new SqlRiteSync(options) as CatalogWriteHandle;

export class CatalogStore {
    readonly #db: CatalogReadHandle;

    private constructor(db: CatalogReadHandle) {
        this.#db = db;
    }

    static openReadOnly(dbPath: string): CatalogStore {
        return new CatalogStore(openReadHandle({ path: dbPath, dir: READ_SQL_DIR, readOnly: true }));
    }

    static openOverlay(primaryPath: string, secondaryPath: string): CatalogStore {
        return new CatalogStore(openReadHandle({
            path: ":memory:",
            dir: [OVERLAY_SQL_DIR, READ_SQL_DIR],
            params: {
                primary_uri: `${pathToFileURL(primaryPath).href}?mode=ro`,
                secondary_uri: `${pathToFileURL(secondaryPath).href}?mode=ro`,
            },
        }));
    }

    getMeta(key: string): string | undefined {
        return this.#db.catalog_get_meta.get<{ value: string }>({ key })?.value;
    }

    lookupProvider(id: string): ProviderRow | undefined {
        return this.#db.catalog_lookup_provider.get<ProviderRow>({ id });
    }

    listProviders(): ProviderRow[] {
        return this.#db.catalog_list_providers.all<ProviderRow>();
    }

    listPopulatedProviders(): ProviderRow[] {
        return this.#db.catalog_list_populated_providers.all<ProviderRow>();
    }

    listProviderEnvs(): { env: string }[] {
        return this.#db.catalog_list_provider_envs.all<{ env: string }>();
    }

    lookupModel(providerId: string, id: string): ModelRow | undefined {
        return this.#db.catalog_lookup_model.get<ModelRow>({ provider_id: providerId, id });
    }

    resolveLeafSuffix(providerId: string, suffix: string): ModelRow[] {
        return this.#db.catalog_resolve_leaf_suffix.all<ModelRow>({ provider_id: providerId, suffix });
    }

    resolvePathSuffix(providerId: string, slashSuffix: string): ModelRow[] {
        return this.#db.catalog_resolve_path_suffix.all<ModelRow>({ provider_id: providerId, slash_suffix: slashSuffix });
    }

    listModels(): ModelRow[] {
        return this.#db.catalog_list_models.all<ModelRow>();
    }

    countProviders(): number {
        return this.#db.catalog_count_providers.get<{ n: number }>()?.n ?? 0;
    }

    countModels(): number {
        return this.#db.catalog_count_models.get<{ n: number }>()?.n ?? 0;
    }

    queryModelsCount(
        providersJson: string,
        search: string,
        minInputCost: number | null,
        maxInputCost: number | null,
    ): number {
        return this.#db.catalog_query_models_count.get<{ total: number }>({
            providers: providersJson,
            search,
            min_input_cost: minInputCost,
            max_input_cost: maxInputCost,
        })?.total ?? 0;
    }

    queryModels(
        providersJson: string,
        search: string,
        minInputCost: number | null,
        maxInputCost: number | null,
        sort: string,
        limit: number,
        offset: number,
    ): QueryModelRow[] {
        return this.#db.catalog_query_models.all<QueryModelRow>({
            providers: providersJson,
            search,
            min_input_cost: minInputCost,
            max_input_cost: maxInputCost,
            sort,
            limit,
            offset,
        });
    }

    close(): void {
        this.#db.close();
    }

    [Symbol.dispose](): void {
        this.close();
    }
}

const leafSuffixOf = (id: string): string | null => {
    const slash = id.lastIndexOf("/");
    return slash === -1 ? null : id.slice(slash + 1);
};

export const rowToProviderInfo = (row: ProviderRow): ProviderInfo => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- env is JSON-serialized string[] checked by STRICT schema
    const env = JSON.parse(row.env) as readonly string[];
    return {
        id: row.id,
        name: row.name,
        adapter: row.adapter,
        env,
        ...(row.api === null ? {} : { api: row.api }),
    };
};

export const rowToModelInfo = (row: ModelRow): ModelInfo => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- modalities JSON arrays validated by projectCatalog
    const input = JSON.parse(row.modalities_input) as readonly string[];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- modalities JSON arrays validated by projectCatalog
    const output = JSON.parse(row.modalities_output) as readonly string[];
    const cost: ModelCost | undefined = row.cost_input !== null && row.cost_output !== null
        ? {
            inputPer1M: row.cost_input,
            outputPer1M: row.cost_output,
            ...(row.cost_reasoning === null ? {} : { reasoningPer1M: row.cost_reasoning }),
            ...(row.cost_cache_read === null ? {} : { cacheReadPer1M: row.cost_cache_read }),
            ...(row.cost_cache_write === null ? {} : { cacheWritePer1M: row.cost_cache_write }),
        }
        : undefined;
    const base = {
        name: row.name,
        contextWindow: row.context_window,
        ...(row.max_input_tokens === null ? {} : { maxInputTokens: row.max_input_tokens }),
        ...(row.max_output_tokens === null ? {} : { maxOutputTokens: row.max_output_tokens }),
        attachment: row.attachment === 1,
        toolCall: row.tool_call === 1,
        ...(row.structured_output === null ? {} : { structuredOutput: row.structured_output === 1 }),
        ...(row.temperature === null ? {} : { temperature: row.temperature === 1 }),
        modalities: { input, output },
        ...(cost === undefined ? {} : { cost }),
    };
    if (row.reasoning === 1) {
        const reasoningOptions = row.reasoning_options === null
            ? []
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reasoningOptions validated by projectCatalog
            : JSON.parse(row.reasoning_options) as readonly ModelReasoningOption[];
        return { ...base, reasoning: true, reasoningOptions };
    }
    return { ...base, reasoning: false };
};

export const writeCatalogDatabase = (
    dbPath: string,
    projected: {
        readonly providers: Readonly<Record<string, ProviderInfo>>;
        readonly catalog: Readonly<Record<string, Readonly<Record<string, ModelInfo>>>>;
    },
    metadata: {
        readonly updatedAt: string;
        readonly etag?: string;
    },
): void => {
    using db = openWriteHandle({ path: dbPath, dir: WRITE_SQL_DIR });
    db.catalog_begin();
    try {
        db.catalog_put_meta.run({ key: "schema_version", value: CATALOG_SCHEMA_VERSION });
        db.catalog_put_meta.run({ key: "updated_at", value: metadata.updatedAt });
        if (metadata.etag !== undefined) {
            db.catalog_put_meta.run({ key: "etag", value: metadata.etag });
        }
        for (const [providerId, provider] of Object.entries(projected.providers)) {
            db.catalog_put_provider.run({
                id: providerId,
                name: provider.name,
                adapter: provider.adapter,
                env: JSON.stringify(provider.env),
                api: provider.api ?? null,
            });
        }
        for (const [providerId, models] of Object.entries(projected.catalog)) {
            for (const [modelId, info] of Object.entries(models)) {
                db.catalog_put_model.run({
                    provider_id: providerId,
                    id: modelId,
                    suffix: leafSuffixOf(modelId),
                    name: info.name,
                    context_window: info.contextWindow,
                    max_input_tokens: info.maxInputTokens ?? null,
                    max_output_tokens: info.maxOutputTokens ?? null,
                    attachment: info.attachment ? 1 : 0,
                    reasoning: info.reasoning ? 1 : 0,
                    reasoning_options: info.reasoning ? JSON.stringify(info.reasoningOptions) : null,
                    tool_call: info.toolCall ? 1 : 0,
                    structured_output: info.structuredOutput === undefined ? null : (info.structuredOutput ? 1 : 0),
                    temperature: info.temperature === undefined ? null : (info.temperature ? 1 : 0),
                    modalities_input: JSON.stringify(info.modalities.input),
                    modalities_output: JSON.stringify(info.modalities.output),
                    cost_input: info.cost?.inputPer1M ?? null,
                    cost_output: info.cost?.outputPer1M ?? null,
                    cost_reasoning: info.cost?.reasoningPer1M ?? null,
                    cost_cache_read: info.cost?.cacheReadPer1M ?? null,
                    cost_cache_write: info.cost?.cacheWritePer1M ?? null,
                });
            }
        }
        db.catalog_commit();
    } catch (cause) {
        db.catalog_rollback();
        throw cause;
    }
    // Seal into a single read-only-safe file (no -wal/-shm sidecars on 0555 install dirs).
    db.catalog_seal();
};

export const openReadOnlyCatalog = (dbPath: string): CatalogStore =>
    CatalogStore.openReadOnly(dbPath);

export const openOverlayCatalog = (primaryPath: string, secondaryPath: string): CatalogStore =>
    CatalogStore.openOverlay(primaryPath, secondaryPath);

export type ValidatedCacheMeta = {
    readonly updatedAt: string;
    readonly etag?: string;
};

export const validateCachedCatalogDb = (cachePath: string): ValidatedCacheMeta | null => {
    if (!existsSync(cachePath)) return null;
    try {
        using db = openReadOnlyCatalog(cachePath);
        const version = db.getMeta("schema_version");
        if (version !== CATALOG_SCHEMA_VERSION) return null;
        const updatedAt = db.getMeta("updated_at");
        if (updatedAt === undefined || !Number.isFinite(Date.parse(updatedAt))) return null;
        for (const provider of db.listProviders()) {
            if (!isProviderAdapter(provider.adapter)) return null;
        }
        const etag = db.getMeta("etag");
        return {
            updatedAt,
            ...(etag === undefined ? {} : { etag }),
        };
    } catch {
        return null;
    }
};
