// {§worker-model-selection} — create-or-lookup for resolved model routes and the
// inverse lookup. The owning boundary resolves aliases to a complete route before
// persistence; no path re-resolves a historical selection through a possibly
// changed alias declaration.

import type { ProviderAlias } from "@plurnk/plurnk-providers";
import type { Db } from "../core/Db.ts";

export const routeForSpec = async (db: Db, spec: ProviderAlias | null): Promise<number | null> => {
    if (spec === null) return null;
    const baseUrl = spec.baseUrl ?? "";
    const existing = await db.model_route_lookup.get<{ id: number }>({
        alias: spec.alias,
        provider: spec.provider,
        model: spec.model,
        base_url: baseUrl,
    });
    if (existing !== undefined) return existing.id;
    const created = await db.model_route_create.get<{ id: number }>({
        alias: spec.alias,
        provider: spec.provider,
        model: spec.model,
        base_url: baseUrl,
    });
    if (created === undefined) throw new Error("model_route_create returned no row");
    return created.id;
};

export const specForRoute = async (db: Db, routeId: number | null): Promise<ProviderAlias | null> => {
    if (routeId === null) return null;
    const row = await db.model_route_by_id.get<{ alias: string; provider: string; model: string; base_url: string }>({ id: routeId });
    if (row === undefined) throw new Error(`model_route ${routeId} is missing`);
    return {
        alias: row.alias,
        provider: row.provider,
        model: row.model,
        ...(row.base_url === "" ? {} : { baseUrl: row.base_url }),
    };
};
