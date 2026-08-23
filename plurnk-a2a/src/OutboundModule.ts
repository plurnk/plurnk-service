// {§a2a-agents-functionality} — the outbound half of the A2A package as a
// daemon module: it registers the `a2a` resource scheme bound to the Worker's
// `agents` Functionality and the family adapter beneath the shared coordinator.
// The hosted inbound listener ({§a2a-inbound-exposure}) remains the separate,
// optional `Module`.
import A2a from "./A2a.ts";
import A2aFunctionality, { type FunctionalityFamilyHandle } from "./Functionality.ts";

interface SetupSeam {
    registerScheme(name: string, handler: object): Promise<void>;
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
        await seam.registerScheme("a2a", new A2a((authority, ctx) => this.#functionality.resolve(authority, ctx.functionalityWorkerId)));
        this.#functionality.attach(seam.registerFunctionalityAdapter(this.#functionality));
    }
}
