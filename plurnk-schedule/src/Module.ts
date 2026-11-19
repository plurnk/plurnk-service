import {
    Problems,
    Validator,
    isRecord,
    type FunctionalityFamilyHandle,
    type JsonSchema,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { DaemonModule, FunctionalitySeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import { readDefinition } from "./definition.ts";
import ScheduleFunctionality, {
    type EnvironmentSeam,
    type ScheduleFunctionalityOptions,
} from "./Functionality.ts";
import { defaultCatchup, parseRule } from "./rules.ts";
import type { ScheduleStatus, ScheduledRule } from "./Scheduler.ts";
import { isoString, zoned } from "./temporal.ts";

type SetupSeam = EnvironmentSeam & FunctionalitySeam<never, RuntimeSchemeFacet>;

type StartSeam = Pick<ApplicationPort, "listWorkspaces" | "listSessions" | "runLoop">
    & Partial<Pick<ApplicationPort, "createSession" | "dispatchClientAction" | "subscribeToEvents">>;

export interface ModuleOptions extends ScheduleFunctionalityOptions {
    readonly env?: NodeJS.ProcessEnv;
}

const RUN_INPUT: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["alias"],
    properties: {
        alias: { type: "string", minLength: 1 },
    },
});

const STATUS_INPUT: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["alias", "status"],
    properties: {
        alias: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["open", "done", "fail"] },
    },
});

const ACTION_OUTPUT: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["alias", "status"],
    properties: {
        alias: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["open", "done", "fail"] },
        loopId: { type: ["integer", "null"] },
        lastFiredAt: { type: ["string", "null"] },
        doneAt: { type: ["string", "null"] },
    },
});

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
        if (seam.registerModuleAction !== undefined) {
            seam.registerModuleAction({
                name: "workspace.schedule.run",
                scope: "workspace",
                residency: "none",
                inputSchema: RUN_INPUT,
                outputSchema: ACTION_OUTPUT,
                handler: async (params, context) => {
                    if (context.scope === "daemon") throw new Error("workspace.schedule.run requires a workspace context");
                    const alias = typeof params.alias === "string" ? params.alias : "";
                    await this.#syncWorkspace(context.workspaceId);
                    const outcome = await this.#functionality.scheduler.runNow(context.workspaceId, alias);
                    return {
                        alias: outcome.alias,
                        status: outcome.status,
                        loopId: outcome.loopId,
                        lastFiredAt: isoString(zoned(outcome.lastFiredAt, "UTC")),
                        doneAt: outcome.doneAt === null ? null : isoString(zoned(outcome.doneAt, "UTC")),
                    };
                },
            });
            seam.registerModuleAction({
                name: "workspace.schedule.status",
                scope: "workspace",
                residency: "none",
                inputSchema: STATUS_INPUT,
                outputSchema: ACTION_OUTPUT,
                handler: async (params, context) => {
                    if (context.scope === "daemon") throw new Error("workspace.schedule.status requires a workspace context");
                    const alias = typeof params.alias === "string" ? params.alias : "";
                    const status: ScheduleStatus =
                        params.status === "done" || params.status === "fail" ? params.status : "open";
                    await this.#syncWorkspace(context.workspaceId);
                    const entry = await this.#functionality.scheduler.setStatus(context.workspaceId, alias, status);
                    return {
                        alias,
                        status: entry.status,
                        loopId: entry.loopId,
                        lastFiredAt: entry.lastFiredAt === null ? null : isoString(zoned(entry.lastFiredAt, "UTC")),
                        doneAt: entry.doneAt === null ? null : isoString(zoned(entry.doneAt, "UTC")),
                    };
                },
            });
        }
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
                const parsed = read.rule === null ? null : parseRule(read.rule);
                const catchup = read.catchup ?? defaultCatchup(parsed);
                rules.set(alias, { alias, definition: read, parsed, catchup });
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
                    if (typeof params.archivedAt === "string") {
                        void this.#functionality.scheduler.sync(workspaceId, new Map(), { preserveLedger: true });
                    } else if (params.archivedAt === null) {
                        void this.#syncWorkspace(workspaceId);
                    }
                    return;
                }
                if (method === "loop/terminated" && workspaceId !== null && isRecord(params)) {
                    const loopId = typeof params.loopId === "number" ? params.loopId : null;
                    const parsedProblem = isRecord(params.result) ? Problems.fromError({ problem: params.result.problem }) : null;
                    const result = isRecord(params.result) && typeof params.result.status === "number"
                        ? {
                            status: params.result.status,
                            ...(parsedProblem === null ? {} : { problem: parsedProblem }),
                        }
                        : null;
                    if (loopId !== null && result !== null) {
                        this.#functionality.scheduler.onLoopTerminated(workspaceId, loopId, result);
                    }
                }
            }, { events: ["workspace/archived", "loop/terminated"] });
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
