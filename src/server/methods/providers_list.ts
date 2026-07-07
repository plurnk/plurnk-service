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
                            // #263/#345 — the denominator for the client's used%/window gauge: the model's
                            // EFFECTIVE PROMPT BUDGET (window minus the partition reserves) — the same number
                            // loop-usage reports, one meaning on every surface. The raw KV overstated usable
                            // room by the reserve total ('ctx 38%/49k' against a 35k reality). Known for the
                            // active alias; null elsewhere → the client omits the gauge.
                            contextSize: isActive && ctx.provider !== null ? ctx.engine.promptBudgetFor(ctx.provider) : null,
                        };
                    }),
                };
            },
            description: "List configured model aliases (PLURNK_MODEL_<alias>), which is active, and the active model's contextSize — the EFFECTIVE prompt budget (window minus reserves, #345), the same denominator loop-usage reports.",
        });
    }
}
