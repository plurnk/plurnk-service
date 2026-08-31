// {§worker-model-selection} — create-or-lookup for resolved model routes and the
// inverse lookup. The owning boundary resolves aliases to a complete route before
// persistence; no path re-resolves a historical selection through a possibly
// changed alias declaration.

import type { ModelRoute, ReasoningPolicy } from "@plurnk/plurnk-contracts";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import { resolveModel } from "@plurnk/plurnk-models";
import type { Db } from "../core/Db.ts";

export const routeForSpec = async (db: Db, spec: ProviderSpec | null): Promise<number | null> => {
    if (spec === null) return null;
    const alias = spec.alias ?? null;
    const baseUrl = spec.baseUrl ?? null;
    const existing = await db.model_route_lookup.get<{ id: number }>({
        alias,
        provider: spec.provider,
        model: spec.model,
        base_url: baseUrl,
    });
    if (existing !== undefined) return existing.id;
    const created = await db.model_route_create.get<{ id: number }>({
        alias,
        provider: spec.provider,
        model: spec.model,
        base_url: baseUrl,
    });
    if (created === undefined) throw new Error("model_route_create returned no row");
    return created.id;
};

export const specForRoute = async (db: Db, routeId: number | null): Promise<ProviderSpec | null> => {
    if (routeId === null) return null;
    const row = await db.model_route_by_id.get<{ alias: string | null; provider: string; model: string; base_url: string | null }>({ id: routeId });
    if (row === undefined) throw new Error(`model_route ${routeId} is missing`);
    return {
        ...(row.alias === null ? {} : { alias: row.alias }),
        provider: row.provider,
        model: row.model,
        ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    };
};

// The provider endpoint is durable construction state, not client model identity.
// {§worker-reasoning-policy} — effort is identity-grade: the worker's durable policy
// rides the route; a model without a reasoning dimension (catalog reasoning: false)
// carries none.
export const projectModelRoute = (spec: ProviderSpec, reasoningPolicy: ReasoningPolicy | null = null): ModelRoute => ({
    ...(spec.alias === undefined ? {} : { alias: spec.alias }),
    provider: spec.provider,
    model: spec.model,
    ...(reasoningPolicy === null || resolveModel(spec.provider, spec.model)?.info.reasoning === false
        ? {}
        : { reasoningPolicy }),
});
