// {§a2a-functionality} — the outbound half of the A2A package as a daemon
// module: it registers the family adapter beneath the shared coordinator, and
// the adapter carries the scheme face that serves `a2a://`. The package's daemon module
// ({§a2a-module}) composes it with the inbound `Exposure` ({§a2a-inbound-exposure}).
import type { DaemonModule, FunctionalitySeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import A2aFunctionality from "./Functionality.ts";
import type { HostedTasksPort } from "./HostedTasks.ts";

// {§module-seam-slices} — the slice this module uses: its adapter carries the `a2a://` facet.
export type OutboundSetupSeam = FunctionalitySeam<never, RuntimeSchemeFacet>;

export default class OutboundModule implements DaemonModule<OutboundSetupSeam, HostedTasksPort> {
    readonly #functionality: A2aFunctionality;

    static init(env: NodeJS.ProcessEnv = process.env): OutboundModule {
        return new OutboundModule(env);
    }

    private constructor(env: NodeJS.ProcessEnv) {
        this.#functionality = new A2aFunctionality(env);
    }

    get functionality(): A2aFunctionality {
        return this.#functionality;
    }

    async setup(seam: OutboundSetupSeam): Promise<void> {
        this.#functionality.attach(seam.registerFunctionalityAdapter(this.#functionality));
    }

    start(port: HostedTasksPort): void {
        this.#functionality.scheme.attach(port);
    }
}
