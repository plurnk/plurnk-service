// {§schedule-family} — the daemon module: registers the family at setup, arms every workspace's
// enabled rules at start from the coordinator's persisted state ({§schedule-residency}), and
// disarms at close.
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import { readDefinition } from "./definition.ts";
import ScheduleFunctionality, {
    SCHEDULE_OWNER,
    type EnvironmentSeam,
    type FunctionalityFamilyHandle,
    type ScheduleFunctionalityOptions,
} from "./Functionality.ts";
import { parseRule } from "./rules.ts";
import type { ScheduledRule } from "./Scheduler.ts";

interface SetupSeam extends EnvironmentSeam {
    registerFunctionalityAdapter(adapter: ScheduleFunctionality): FunctionalityFamilyHandle;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null>;
}

type StartSeam = Pick<ApplicationPort, "listWorkspaces" | "listWorkers" | "runLoop">;

// {§functionality-state} as the coordinator persists it: service aliases carry enabledness,
// the workspace's own carry their definition.
interface FamilyState {
    readonly version: 1;
    readonly definitions: Readonly<Record<string, {
        readonly origin: "service" | "workspace" | "worker";
        readonly definition?: object;
        readonly enabled: boolean;
    }>>;
}

export interface ModuleOptions extends ScheduleFunctionalityOptions {
    readonly env?: NodeJS.ProcessEnv;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export default class Module {
    readonly #env: NodeJS.ProcessEnv;
    readonly #functionality: ScheduleFunctionality;
    readonly #report: (message: string, cause: unknown) => void;
    #seam: SetupSeam | null = null;
    #started = false;

    static init(options: ModuleOptions = {}): Module {
        return new Module(options);
    }

    private constructor(options: ModuleOptions) {
        const { env, ...functionality } = options;
        this.#env = env ?? process.env;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#functionality = new ScheduleFunctionality(this.#env, functionality);
    }

    get functionality(): ScheduleFunctionality {
        return this.#functionality;
    }

    setup(seam: SetupSeam): void {
        if (this.#seam !== null) throw new Error("schedule module already set up");
        this.#seam = seam;
        this.#functionality.attach(seam.registerFunctionalityAdapter(this.#functionality), seam);
    }

    async start(seam: StartSeam): Promise<void> {
        const setup = this.#seam;
        if (setup === null) throw new Error("schedule module started before setup");
        if (this.#started) throw new Error("schedule module already started");
        this.#started = true;
        this.#functionality.scheduler.start(seam);
        const service = this.#functionality.service();
        for (const workspace of await seam.listWorkspaces()) {
            const state = Module.#state(await setup.readWorkspaceModuleState(workspace.id, SCHEDULE_OWNER));
            const effective = new Map<string, { definition: object; enabled: boolean }>();
            for (const [alias, { definition, enabled }] of service) effective.set(alias, { definition, enabled });
            for (const [alias, record] of Object.entries(state.definitions)) {
                if (record.origin !== "service") {
                    effective.set(alias, { definition: record.definition!, enabled: record.enabled });
                    continue;
                }
                const base = effective.get(alias);
                if (base !== undefined) effective.set(alias, { ...base, enabled: record.enabled });
            }
            const rules = new Map<string, ScheduledRule>();
            for (const [alias, { definition, enabled }] of effective) {
                if (!enabled) continue;
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

    async close(): Promise<void> {
        await this.#functionality.scheduler.close();
    }

    static #state(raw: unknown): FamilyState {
        if (raw === null) return { version: 1, definitions: {} };
        if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.definitions)) {
            throw new Error("schedule state in workspace_module_state is not a version-1 family state");
        }
        return raw as unknown as FamilyState;
    }
}
