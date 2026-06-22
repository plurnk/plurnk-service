import type MethodRegistry from "../MethodRegistry.ts";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";

export default class ProvidersListMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("providers.list", {
            handler: async (_params, ctx) => {
                const aliases = parseAliasesFromEnv();
                const active = resolveActiveAlias();
                return {
                    aliases: aliases.map((a) => {
                        const isActive = active !== null && active.alias === a.alias;
                        return {
                            alias: a.alias,
                            provider: a.provider,
                            model: a.model,
                            active: isActive,
                            // #263 — the model's context window, the denominator for the client's used%/window
                            // gauge. Known for the active alias (its provider is instantiated at boot); null
                            // elsewhere and when the provider can't determine it → the client omits the gauge.
                            contextSize: isActive ? (ctx.provider?.contextSize ?? null) : null,
                        };
                    }),
                };
            },
            description: "List configured model aliases (PLURNK_MODEL_<alias>), which is active, and the active model's contextSize (#263).",
        });
    }
}
