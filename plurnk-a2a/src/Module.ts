// {§a2a-module} — the package's one daemon module: the outbound family always, and the inbound
// exposure when its own settings select it ({§module-self-activation}). An invalid exposure setting
// withholds the exposure alone ({§module-contained-configuration}).
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { ContainedConfiguration, DaemonModule, StartedModule } from "@plurnk/plurnk-modules";
import { hostedAgentConfiguration } from "./config.ts";
import Exposure, { type A2aExposureRegistration, type ExposurePort } from "./Exposure.ts";
import OutboundModule, { type OutboundSetupSeam } from "./OutboundModule.ts";

export default class Module implements DaemonModule<OutboundSetupSeam, ExposurePort> {
    readonly mounts?: readonly string[];
    readonly contained?: readonly ContainedConfiguration[];
    readonly #outbound: OutboundModule;
    readonly #exposure: A2aExposureRegistration | null;

    static init(env: NodeJS.ProcessEnv = process.env): Module {
        return new Module(env);
    }

    private constructor(env: NodeJS.ProcessEnv) {
        this.#outbound = OutboundModule.init(env);
        let exposure: A2aExposureRegistration | null = null;
        try {
            const configuration = hostedAgentConfiguration(env);
            if (configuration !== null) exposure = Exposure.init(configuration);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.contained = [{ key: cause.key, message: cause.message }];
        }
        this.#exposure = exposure;
        if (exposure !== null) this.mounts = exposure.mounts;
    }

    async setup(seam: OutboundSetupSeam): Promise<void> {
        await this.#outbound.setup(seam);
    }

    async start(port: ExposurePort): Promise<StartedModule | void> {
        return await this.#exposure?.start(port);
    }
}
