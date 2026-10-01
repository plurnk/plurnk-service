import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import { scopeEnvToAlias, type Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import Results, { OperationFailureError } from "./results.ts";

export default class ReasoningPolicy {
    // {§reasoning-reboot-configuration}
    static reboot(provider: Provider): boolean {
        const env = scopeEnvToAlias(process.env, ProviderInstantiate.configurationAliasOf(provider) ?? "", [
            "PLURNK_SERVICE_REASONING_REBOOT",
        ]);
        try {
            return Knob.flag("PLURNK_SERVICE_REASONING_REBOOT", env);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
    }
}
