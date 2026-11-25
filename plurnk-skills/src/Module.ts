import { errnoCode } from "@plurnk/plurnk-contracts";
import { SkillResourceError } from "@plurnk/plurnk-agent-skills";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import type { ContainedConfiguration, DaemonModule, FunctionalitySeam } from "@plurnk/plurnk-modules";
import { Results, type ResourceTreeRegistrationSeam, type ResourceTreeSource } from "@plurnk/plurnk-schemes";
import SkillsFunctionality, {
    publicOnly,
    serviceSkills,
    workspaceSources,
    type SourceSeam,
} from "./Functionality.ts";

type SetupSeam = SourceSeam & FunctionalitySeam & ResourceTreeRegistrationSeam;

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
}

// {§skills-module} — only the family and its source tree belong to this module.
export default class Module implements DaemonModule<SetupSeam> {
    readonly contained: readonly ContainedConfiguration[];
    readonly #env: NodeJS.ProcessEnv | undefined;
    #functionality: SkillsFunctionality | null = null;

    static init(options: ModuleOptions = {}): Module {
        return new Module(options);
    }

    private constructor(options: ModuleOptions) {
        this.#env = options.env;
        const env = options.env ?? process.env;
        const contained: ContainedConfiguration[] = [];
        for (const check of [
            () => Knob.integer("PLURNK_SKILLS_FETCH_TIMEOUT_MS", 1, env),
            () => workspaceSources(env),
            () => publicOnly(env),
            () => serviceSkills(env),
        ]) {
            try {
                check();
            } catch (cause) {
                if (!(cause instanceof ConfigurationError)) throw cause;
                contained.push({ key: cause.key, message: cause.message });
            }
        }
        this.contained = contained;
    }

    async setup(seam: SetupSeam): Promise<void> {
        if (this.#functionality !== null) throw new Error("skills module already set up");
        const functionality = new SkillsFunctionality(seam, this.#env === undefined ? {} : { env: this.#env });
        this.#functionality = functionality;
        functionality.attach(seam.registerFunctionalityAdapter(functionality));
        await seam.registerResourceTreeScheme("skill", {
            trees: (workspaceId) => functionality.trees(workspaceId),
            refusal: Module.#refusal,
        });
    }

    static readonly #refusal: NonNullable<ResourceTreeSource["refusal"]> = (cause, address) => {
        const target = `skill://${address.authority}${address.pathname}`;
        if (errnoCode(cause) === "ENOENT") {
            return Results.failure("scheme:skill", "entry-not-found", 404, `No skill resource exists at ${target}.`, {}, { target });
        }
        if (!(cause instanceof SkillResourceError)) return null;
        const outside = cause.code === "SKILL_PATH_OUTSIDE_ROOT";
        return Results.failure("scheme:skill", outside ? "resource-outside-root" : "resource-invalid", outside ? 403 : 400, cause.message, {}, { target });
    };
}
