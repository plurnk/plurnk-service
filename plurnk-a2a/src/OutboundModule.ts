// {§a2a-functionality} — the outbound half of the A2A package as a daemon
// module: it registers the family adapter beneath the shared coordinator, and
// the adapter carries the scheme face that serves `a2a://`. The hosted inbound
// listener ({§a2a-inbound-exposure}) remains the separate, optional `Module`.
import A2aFunctionality, { type FunctionalityFamilyHandle } from "./Functionality.ts";

interface SetupSeam {
    registerFunctionalityAdapter(adapter: A2aFunctionality): FunctionalityFamilyHandle;
}

export default class OutboundModule {
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

    async setup(seam: SetupSeam): Promise<void> {
        this.#functionality.attach(seam.registerFunctionalityAdapter(this.#functionality));
    }
}
