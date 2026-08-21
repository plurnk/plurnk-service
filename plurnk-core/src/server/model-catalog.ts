import {
    Validator,
    type ModelCatalogEntry,
    type ModelCatalogPage,
    type ModelCatalogQuery,
    type ModelReadiness,
} from "@plurnk/plurnk-contracts";
import {
    catalogSnapshot,
    providerCatalogSnapshot,
    providerNameFromCatalogId,
} from "@plurnk/plurnk-models";
import { providerReadiness } from "@plurnk/plurnk-providers";

const DEFAULT_LIMIT = 50;

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const entryMatches = (entry: ModelCatalogEntry, search: string): boolean => [
    entry.selector,
    entry.provider,
    entry.providerName,
    entry.model,
    entry.modelName,
].some((value) => value.toLowerCase().includes(search));

// {§model-catalog} Core composes the release-pinned Models.dev facts with the
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
    const limit = query.limit ?? DEFAULT_LIMIT;
    const providers = providerCatalogSnapshot();
    const readinessByProvider = new Map<string, ModelReadiness>();
    const entries: ModelCatalogEntry[] = [];

    for (const [catalogProviderId, models] of Object.entries(catalogSnapshot())) {
        const provider = providerNameFromCatalogId(catalogProviderId);
        if (requestedProvider !== undefined && provider.toLowerCase() !== requestedProvider) continue;
        const providerInfo = providers[catalogProviderId];
        if (providerInfo === undefined) {
            throw new Error(`Models.dev catalog provider '${catalogProviderId}' has no provider facts`);
        }
        let readiness = readinessByProvider.get(provider);
        if (readiness === undefined) {
            const resolved = providerReadiness(provider, env);
            if (resolved === null) {
                throw new Error(`Models.dev catalog provider '${catalogProviderId}' has no supported runtime adapter`);
            }
            readiness = resolved;
            readinessByProvider.set(provider, readiness);
        }
        if (availability === "configured" && !readiness.ready) continue;

        for (const [model, info] of Object.entries(models)) {
            const selector = `${provider}/${model}`;
            const entry: ModelCatalogEntry = {
                selector,
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
                    toolCall: info.toolCall,
                    ...(info.structuredOutput === undefined ? {} : { structuredOutput: info.structuredOutput }),
                    ...(info.temperature === undefined ? {} : { temperature: info.temperature }),
                    inputModalities: [...info.modalities.input],
                    outputModalities: [...info.modalities.output],
                },
                readiness,
            };
            if (search.length === 0 || entryMatches(entry, search)) entries.push(entry);
        }
    }

    entries.sort((left, right) => compareText(left.selector, right.selector));
    const items = entries.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return Validator.assertModelCatalogPage({
        items,
        offset,
        total: entries.length,
        ...(nextOffset < entries.length ? { nextOffset } : {}),
    });
};
