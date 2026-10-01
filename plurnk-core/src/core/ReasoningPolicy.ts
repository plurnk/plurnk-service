import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import { scopeEnvToAlias, type Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import Results, { OperationFailureError } from "./results.ts";

export default class ReasoningPolicy {
    // {§reasoning-operations-configuration} {§reasoning-reboot-configuration}
    static read(provider: Provider): { operations: boolean; reboot: boolean } {
        const env = scopeEnvToAlias(process.env, ProviderInstantiate.configurationAliasOf(provider) ?? "", [
            "PLURNK_SERVICE_REASONING_OPERATIONS", "PLURNK_SERVICE_REASONING_REBOOT",
        ]);
        try {
            const operations = Knob.flag("PLURNK_SERVICE_REASONING_OPERATIONS", env);
            const reboot = Knob.flag("PLURNK_SERVICE_REASONING_REBOOT", env);
            return { operations, reboot: operations && reboot };
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
    }
}
