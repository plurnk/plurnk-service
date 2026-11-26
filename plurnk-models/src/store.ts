// {§model-catalog-build} {§model-catalog-cache} — SqlRite-backed catalog storage, read-only
// inspection, and ATTACH + TEMP VIEW overlay management (#1576).

import SqlRiteSync from "@possumtech/sqlrite/sync";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isProviderAdapter } from "./project.ts";
import type { ModelCost, ModelInfo, ModelReasoningOption, ProviderInfo } from "./index.ts";

export const CATALOG_SCHEMA_VERSION = "1";

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

export type CatalogReadDb = {
    readonly catalog_get_meta: { get(params: { key: string }): { value: string } | undefined };
    readonly catalog_lookup_provider: { get(params: { id: string }): ProviderRow | undefined };
    readonly catalog_list_providers: { all(): ProviderRow[] };
    readonly catalog_list_populated_providers: { all(): ProviderRow[] };
    readonly catalog_list_provider_envs: { all(): { env: string }[] };
    readonly catalog_lookup_model: { get(params: { provider_id: string; id: string }): ModelRow | undefined };
    readonly catalog_resolve_leaf_suffix: { all(params: { provider_id: string; suffix: string }): ModelRow[] };
    readonly catalog_resolve_path_suffix: { all(params: { provider_id: string; slash_suffix: string }): ModelRow[] };
    readonly catalog_list_models: { all(): ModelRow[] };
    readonly catalog_count_providers: { get(): { n: number } | undefined };
    readonly catalog_count_models: { get(): { n: number } | undefined };
    readonly catalog_query_models: { all(params: { providers: string; search: string; limit: number; offset: number }): QueryModelRow[] };
    readonly catalog_query_models_count: { get(params: { providers: string; search: string }): { total: number } | undefined };
    close(): void;
};

type CatalogWriteDb = {
    catalog_begin(): unknown;
    catalog_commit(): unknown;
    catalog_rollback(): unknown;
    catalog_seal(): unknown;
    readonly catalog_put_meta: { run(params: { key: string; value: string }): unknown };
    readonly catalog_put_provider: {
        run(params: { id: string; name: string; adapter: string; env: string; api: string | null }): unknown;
    };
    readonly catalog_put_model: {
        run(params: {
            provider_id: string;
            id: string;
            suffix: string | null;
            name: string;
            context_window: number;
            max_input_tokens: number | null;
            max_output_tokens: number | null;
            attachment: number;
            reasoning: number;
            reasoning_options: string | null;
            tool_call: number;
            structured_output: number | null;
            temperature: number | null;
            modalities_input: string;
            modalities_output: string;
            cost_input: number | null;
            cost_output: number | null;
            cost_reasoning: number | null;
            cost_cache_read: number | null;
            cost_cache_write: number | null;
        }): unknown;
    };
    close(): void;
};

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SqlRiteSync binds named methods from write/catalog.sql
    const db = new SqlRiteSync({ path: dbPath, dir: WRITE_SQL_DIR }) as unknown as CatalogWriteDb;
    try {
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
    } finally {
        db.close();
    }
};

export const openReadOnlyCatalog = (dbPath: string): CatalogReadDb => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SqlRiteSync binds named queries from read/catalog.sql
    return new SqlRiteSync({ path: dbPath, dir: READ_SQL_DIR, readOnly: true }) as unknown as CatalogReadDb;
};

export const openOverlayCatalog = (primaryPath: string, secondaryPath: string): CatalogReadDb => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SqlRiteSync binds named queries from read/catalog.sql over overlay views
    return new SqlRiteSync({
        path: ":memory:",
        dir: [OVERLAY_SQL_DIR, READ_SQL_DIR],
        params: {
            primary_uri: `${pathToFileURL(primaryPath).href}?mode=ro`,
            secondary_uri: `${pathToFileURL(secondaryPath).href}?mode=ro`,
        },
    }) as unknown as CatalogReadDb;
};

export type ValidatedCacheMeta = {
    readonly updatedAt: string;
    readonly etag?: string;
};

export const validateCachedCatalogDb = (cachePath: string): ValidatedCacheMeta | null => {
    if (!existsSync(cachePath)) return null;
    let db: CatalogReadDb | undefined;
    try {
        db = openReadOnlyCatalog(cachePath);
        const version = db.catalog_get_meta.get({ key: "schema_version" })?.value;
        if (version !== CATALOG_SCHEMA_VERSION) return null;
        const updatedAt = db.catalog_get_meta.get({ key: "updated_at" })?.value;
        if (updatedAt === undefined || !Number.isFinite(Date.parse(updatedAt))) return null;
        const providers = db.catalog_list_providers.all();
        for (const provider of providers) {
            if (!isProviderAdapter(provider.adapter)) return null;
        }
        const etag = db.catalog_get_meta.get({ key: "etag" })?.value;
        return {
            updatedAt,
            ...(etag === undefined ? {} : { etag }),
        };
    } catch {
        return null;
    } finally {
        db?.close();
    }
};
