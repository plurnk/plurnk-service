import type { FunctionalityFamilyHandle, FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
// {§schedule-family} — the daemon module: registers the family at setup, arms every workspace's
// enabled rules at start from the coordinator's persisted state ({§schedule-residency}), and
// disarms during producer stop ({§module-shutdown-order}).
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { DaemonModule, FunctionalitySeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import { readDefinition } from "./definition.ts";
import ScheduleFunctionality, {
    type EnvironmentSeam,
    type ScheduleFunctionalityOptions,
} from "./Functionality.ts";
import { parseRule } from "./rules.ts";
import type { ScheduledRule } from "./Scheduler.ts";

// {§module-seam-slices} — the slices this module uses.
type SetupSeam = EnvironmentSeam & FunctionalitySeam<never, RuntimeSchemeFacet>;

type StartSeam = Pick<ApplicationPort, "listWorkspaces" | "listWorkers" | "runLoop">;

export interface ModuleOptions extends ScheduleFunctionalityOptions {
    readonly env?: NodeJS.ProcessEnv;
}

export default class Module implements DaemonModule<SetupSeam, StartSeam> {
    readonly #functionality: ScheduleFunctionality;
    readonly #report: (message: string, cause: unknown) => void;
    #handle: FunctionalityFamilyHandle | null = null;
    #started = false;
    #stopping: Promise<void> | null = null;

    static init(options: ModuleOptions = {}): Module {
        return new Module(options);
    }

    private constructor(options: ModuleOptions) {
        const { env, ...functionality } = options;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#functionality = new ScheduleFunctionality(env, functionality);
    }

    get functionality(): ScheduleFunctionality {
        return this.#functionality;
    }

    setup(seam: SetupSeam): void {
        if (this.#handle !== null) throw new Error("schedule module already set up");
        this.#handle = seam.registerFunctionalityAdapter(this.#functionality);
        this.#functionality.attach(this.#handle, seam);
    }

    async start(seam: StartSeam): Promise<void> {
        const handle = this.#handle;
        if (handle === null) throw new Error("schedule module started before setup");
        if (this.#started) throw new Error("schedule module already started");
        this.#started = true;
        this.#functionality.scheduler.start(seam);
        for (const workspace of await seam.listWorkspaces()) {
            let listing;
            try {
                listing = await handle.invoke("list", {}, { workspaceId: workspace.id });
            } catch (cause) {
                if (!(cause instanceof Error) || !(cause.cause instanceof ConfigurationError)) throw cause;
                this.#report(`schedules in workspace ${workspace.id} remain disarmed`, cause.message);
                continue;
            }
            const rules = new Map<string, ScheduledRule>();
            for (const { alias, definition, state } of (listing.body as FunctionalityListResult).definitions) {
                if (state === "disabled") continue;
                try {
                    const read = readDefinition(definition);
                    rules.set(alias, { alias, definition: read, parsed: parseRule(read.rule) });
                } catch (cause) {
                    this.#report(`schedule '${alias}' in workspace ${workspace.id} is unreadable and stays disarmed`, cause);
                }
            }
            await this.#functionality.scheduler.sync(workspace.id, rules);
        }
    }

    stop(): Promise<void> {
        this.#stopping ??= this.#functionality.scheduler.close();
        return this.#stopping;
    }
}
