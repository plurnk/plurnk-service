// {§persona-discovery} — daemon module composing `personas` Functionality, `persona://` resource tree,
// and the workspace persona projection reader.
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type {
    ContainedConfiguration,
    DaemonModule,
    FunctionalitySeam,
    PersonaRegistrySeam,
} from "@plurnk/plurnk-modules";
import type { ResourceTreeRegistrationSeam } from "@plurnk/plurnk-schemes";
import PersonasFunctionality, { type PersonaSourceSeam } from "./Functionality.ts";
import { PersonaScheme } from "./PersonaScheme.ts";

export type PersonasSetupSeam = PersonaSourceSeam
    & FunctionalitySeam
    & ResourceTreeRegistrationSeam
    & PersonaRegistrySeam;

export interface PersonasModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
}

export default class Module implements DaemonModule<PersonasSetupSeam> {
    readonly contained: readonly ContainedConfiguration[];
    readonly #env: NodeJS.ProcessEnv | undefined;
    #functionality: PersonasFunctionality | null = null;

    static init(options: PersonasModuleOptions = {}): Module {
        return new Module(options);
    }

    private constructor(options: PersonasModuleOptions) {
        this.#env = options.env;
        try {
            PersonasFunctionality.validateConfiguration(options.env ?? process.env);
            this.contained = [];
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.contained = [{ key: cause.key, message: cause.message }];
        }
    }

    async setup(seam: PersonasSetupSeam): Promise<void> {
        if (this.#functionality !== null) throw new Error("personas module already set up");
        const functionality = new PersonasFunctionality(
            seam,
            this.#env === undefined ? {} : { env: this.#env },
        );
        this.#functionality = functionality;
        const handle = seam.registerFunctionalityAdapter(functionality);
        functionality.attach(handle);
        seam.registerPersonaReader((workspaceId) => functionality.read(workspaceId));
        await seam.registerResourceTreeScheme(
            "persona",
            new PersonaScheme(
                functionality,
                (verb, params, identity, caller = "operation") =>
                    handle.invoke(verb, params, identity, caller),
            ),
        );
    }
}
