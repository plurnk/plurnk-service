import {
    Validator,
    type ModelCatalogEntry,
    type ModelCatalogPage,
    type ModelCatalogQuery,
    type ModelReadiness,
} from "@plurnk/plurnk-contracts";
import {
    listCatalogProviders,
    providerNameFromCatalogId,
    queryCatalog,
} from "@plurnk/plurnk-models";
import { catalogEfforts, providerReadiness } from "@plurnk/plurnk-providers";
import { Knob } from "@plurnk/plurnk-meta";

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

// {§session-model-selection} Core composes the SQLite Models.dev catalog with the
// provider owner's local readiness predicate. Enumeration is pure local work:
// it never probes, authenticates, selects, or invokes a model.
export const listModelCatalog = (
    input: ModelCatalogQuery,
    env: NodeJS.ProcessEnv = process.env,
): ModelCatalogPage => {
    const query = Validator.assertModelCatalogQuery(input);
    const requestedProvider = query.provider?.toLowerCase();
    const search = query.search?.trim().toLowerCase() ?? "";
    const availability = query.availability ?? "configured";
    const offset = query.offset ?? 0;
    const limit = query.limit ?? Knob.integer("PLURNK_SERVICE_MODEL_CATALOG_PAGE", 1);
    const readinessByProvider = new Map<string, ModelReadiness>();
    const availableProviders = new Set<string>();
    const queriedCatalogProviderIds: string[] = [];

    for (const providerInfo of listCatalogProviders()) {
        const provider = providerNameFromCatalogId(providerInfo.id);
        const resolved = providerReadiness(provider, env);
        if (resolved === null) {
            throw new Error(`Models.dev catalog provider '${providerInfo.id}' has no supported runtime adapter`);
        }
        readinessByProvider.set(provider, resolved);
        if (availability === "configured" && !resolved.ready) continue;
        availableProviders.add(provider);
        if (requestedProvider !== undefined && provider.toLowerCase() !== requestedProvider) continue;
        queriedCatalogProviderIds.push(providerInfo.id);
    }

    const { items: rows, total } = queryCatalog({
        providers: queriedCatalogProviderIds,
        ...(search.length === 0 ? {} : { search }),
        offset,
        limit,
    });
    const items: ModelCatalogEntry[] = rows.map(({ provider: providerInfo, id: model, info }) => {
        const provider = providerNameFromCatalogId(providerInfo.id);
        const readiness = readinessByProvider.get(provider);
        if (readiness === undefined) {
            throw new Error(`Models.dev catalog provider '${providerInfo.id}' has no readiness state`);
        }
        return {
            selector: `${provider}/${model}`,
            provider,
            providerName: providerInfo.name,
            model,
            modelName: info.name,
            limits: {
                contextTokens: info.contextWindow,
                ...(info.maxInputTokens === undefined ? {} : { inputTokens: info.maxInputTokens }),
                ...(info.maxOutputTokens === undefined ? {} : { outputTokens: info.maxOutputTokens }),
            },
            capabilities: {
                attachment: info.attachment,
                reasoning: info.reasoning,
                efforts: [...catalogEfforts(providerInfo, info, env)],
                toolCall: info.toolCall,
                ...(info.structuredOutput === undefined ? {} : { structuredOutput: info.structuredOutput }),
                ...(info.temperature === undefined ? {} : { temperature: info.temperature }),
                inputModalities: [...info.modalities.input],
                outputModalities: [...info.modalities.output],
            },
            readiness,
        };
    });

    const nextOffset = offset + items.length;
    return Validator.assertModelCatalogPage({
        items,
        offset,
        total,
        ...(nextOffset < total ? { nextOffset } : {}),
        ...(availableProviders.size > 0 ? { providers: [...availableProviders].toSorted(compareText) } : {}),
    });
};
