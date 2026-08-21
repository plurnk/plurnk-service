import type { ModelRoute } from "@plurnk/plurnk-contracts";

// ProviderSpec is the daemon-private resolved construction identity. Its endpoint
// override never enters the client-visible ModelRoute wire projection.
export type ProviderSpec = ModelRoute & { readonly baseUrl?: string };
export type ProviderAlias = ProviderSpec & { readonly alias: string };
export type { ModelRoute } from "@plurnk/plurnk-contracts";
