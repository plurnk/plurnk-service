import type {
    CatalogResource,
    FindResult,
    MatchLocation,
} from "../../src/schemes/_entry-find.ts";

export const resourceGroups = (result: Pick<FindResult, "results">): CatalogResource[] =>
    result.results.filter((item): item is CatalogResource => Array.isArray(item));

export const resourcePaths = (result: Pick<FindResult, "results">): string[] =>
    resourceGroups(result).map(([item]) => item.path);

export const matchLocations = (result: Pick<FindResult, "results">): MatchLocation[] =>
    result.results.filter((item): item is MatchLocation => !Array.isArray(item));
