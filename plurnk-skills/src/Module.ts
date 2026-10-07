import { SkillResourceError } from "@plurnk/plurnk-agent-skills";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { ContainedConfiguration, DaemonModule, FunctionalitySeam } from "@plurnk/plurnk-modules";
import { Results, type ResourceTreeRegistrationSeam, type ResourceTreeSource } from "@plurnk/plurnk-schemes";
import SkillsFunctionality, { type SourceSeam } from "./Functionality.ts";

type SetupSeam = SourceSeam & FunctionalitySeam & ResourceTreeRegistrationSeam;

// {§skills-module} — only the family and its source tree belong to this module.
export default class Module implements DaemonModule<SetupSeam> {
    readonly contained: readonly ContainedConfiguration[];
    #functionality: SkillsFunctionality | null = null;

    static init(): Module {
        return new Module();
    }

    private constructor() {
        try {
            SkillsFunctionality.validateConfiguration();
            this.contained = [];
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.contained = [{ key: cause.key, message: cause.message }];
        }
    }

    async setup(seam: SetupSeam): Promise<void> {
        if (this.#functionality !== null) throw new Error("skills module already set up");
        const functionality = new SkillsFunctionality(seam);
        this.#functionality = functionality;
        functionality.attach(seam.registerFunctionalityAdapter(functionality));
        await seam.registerResourceTreeScheme("skill", {
            trees: (workspaceId) => functionality.trees(workspaceId),
            refusal: Module.#refusal,
        });
    }

    static readonly #refusal: NonNullable<ResourceTreeSource["refusal"]> = (cause, address) => {
        const target = `skill://${address.authority}${address.pathname}`;
        if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
            return Results.failure("scheme:skill", "entry-not-found", 404, `No skill resource exists at ${target}.`, {}, { target });
        }
        if (!(cause instanceof SkillResourceError)) return null;
        const outside = cause.code === "SKILL_PATH_OUTSIDE_ROOT";
        return Results.failure("scheme:skill", outside ? "resource-outside-root" : "resource-invalid", outside ? 403 : 400, cause.message, {}, { target });
    };
}
