import type { ByteSource } from "./ByteSource.ts";
import type { EntryCoordinate } from "./types.ts";
import type { RepresentationPreparationResult } from "./Results.ts";

// {§resource-tree-scheme} — source truth, without a storage or selection API.
export interface ResourceTree {
    list(): Promise<readonly string[]>;
    resource(relativePath: string): ByteSource;
}

export interface ResourceTreeSource {
    trees(workspaceId: number): ReadonlyMap<string, ResourceTree>;
    // Translate only recognized source failures. null leaves normal missing-file
    // handling or the original unexpected exception with the host.
    refusal?(cause: unknown, address: EntryCoordinate): RepresentationPreparationResult | null;
}

export interface ResourceTreeRegistrationSeam {
    registerResourceTreeScheme(name: string, source: ResourceTreeSource): Promise<void>;
}
