import type MethodRegistry from "../MethodRegistry.ts";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";

export default class ProvidersListMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("providers.list", {
            handler: async () => {
                const aliases = parseAliasesFromEnv();
                const active = resolveActiveAlias();
                return {
                    aliases: aliases.map((a) => ({
                        alias: a.alias,
                        provider: a.provider,
                        model: a.model,
                        active: active !== null && active.alias === a.alias,
                    })),
                };
            },
            description: "List configured model aliases (PLURNK_MODEL_<alias>) and which one is active.",
        });
    }
}
