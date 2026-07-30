import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type { FindStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { SchemeCtx, SchemeResult } from "@plurnk/plurnk-schemes";
import type { Executor } from "../core/ExecutorRegistry.ts";

export type ModuleActionHandler = (
    params: Readonly<Record<string, unknown>>,
) => unknown | Promise<unknown>;

// A module-owned executor may expose protocol resources under the same scheme
// name as its output streams. The facet claims only its own path subtree;
// unclaimed coordinates retain the standard executor-output behavior.
export interface RuntimeSchemeFacet {
    claims(pathname: string): boolean;
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}

export interface RuntimeRegistration {
    readonly decl: RuntimeDecl;
    readonly executor: Executor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}

export interface ModuleSetupSeam {
    registerRuntime(registration: RuntimeRegistration): Promise<void>;
    registerScheme(name: string, handler: object): Promise<void>;
    registerModuleAction(name: string, handler: ModuleActionHandler): void;
}

export interface StartedModule {
    close(): void | Promise<void>;
}

export interface DaemonModule<StartSeam> {
    close?(): void | Promise<void>;
    setup?(seam: ModuleSetupSeam): void | Promise<void>;
    start?(seam: StartSeam): void | StartedModule | Promise<void | StartedModule>;
}
