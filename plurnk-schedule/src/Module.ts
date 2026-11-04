import { Validator, isRecord, type FunctionalityFamilyHandle } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { ConfigurationError } from "@plurnk/plurnk-meta";
// {§schedule-family} — the daemon module: registers the family at setup, arms every workspace's
// enabled rules at start from the coordinator's persisted state ({§schedule-residency}), and
// disarms during producer stop ({§module-shutdown-order}).
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

type StartSeam = Pick<ApplicationPort, "listWorkspaces" | "listSessions" | "runLoop">
    & Partial<Pick<ApplicationPort, "subscribeToEvents">>;

export interface ModuleOptions extends ScheduleFunctionalityOptions {
    readonly env?: NodeJS.ProcessEnv;
}

export default class Module implements DaemonModule<SetupSeam, StartSeam> {
    readonly #functionality: ScheduleFunctionality;
    readonly #report: (message: string, cause: unknown) => void;
    #handle: FunctionalityFamilyHandle | null = null;
    #unsubscribe: (() => void) | null = null;
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

    async #syncWorkspace(workspaceId: number): Promise<void> {
        const handle = this.#handle;
        if (handle === null) return;
        let listing;
        try {
            listing = await handle.invoke("list", {}, { workspaceId });
        } catch (cause) {
            if (!(cause instanceof Error) || !(cause.cause instanceof ConfigurationError)) throw cause;
            this.#report(`schedules in workspace ${workspaceId} remain disarmed`, cause.message);
            return;
        }
        const rules = new Map<string, ScheduledRule>();
        for (const { alias, definition, state } of Validator.assertFunctionalityListResult(listing.body).definitions) {
            if (state === "disabled") continue;
            try {
                const read = readDefinition(definition);
                rules.set(alias, { alias, definition: read, parsed: parseRule(read.rule) });
            } catch (cause) {
                this.#report(`schedule '${alias}' in workspace ${workspaceId} is unreadable and stays disarmed`, cause);
            }
        }
        await this.#functionality.scheduler.sync(workspaceId, rules);
    }

    async start(seam: StartSeam): Promise<void> {
        const handle = this.#handle;
        if (handle === null) throw new Error("schedule module started before setup");
        if (this.#started) throw new Error("schedule module already started");
        this.#started = true;
        this.#functionality.scheduler.start(seam);
        if (seam.subscribeToEvents !== undefined) {
            this.#unsubscribe = seam.subscribeToEvents((workspaceId, method, params) => {
                if (method === "workspace/archived" && workspaceId !== null && isRecord(params)) {
                    if (params.archived === true) {
                        void this.#functionality.scheduler.sync(workspaceId, new Map());
                    } else if (params.archived === false) {
                        void this.#syncWorkspace(workspaceId);
                    }
                }
            });
        }
        for (const workspace of await seam.listWorkspaces({ archived: false })) {
            if ("archived_at" in workspace && workspace.archived_at !== null && workspace.archived_at !== undefined) continue;
            await this.#syncWorkspace(workspace.id);
        }
    }

    stop(): Promise<void> {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#stopping ??= this.#functionality.scheduler.close();
        return this.#stopping;
    }
}
