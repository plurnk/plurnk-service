import test, { type TestContext, type TestOptions } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { type LiveRequirement, needsRoute, type RouteFacts, unmetRequirements } from "./live-requirements.ts";

// {§tier-census} — a specimen is its name and what it requires of the route.
export interface LiveSpecimen {
    readonly name: string;
    readonly requires: readonly LiveRequirement[];
}
export interface LiveTestOptions extends TestOptions {
    readonly requires?: readonly LiveRequirement[];
}
type LiveBody = (context: TestContext) => void | Promise<void>;
export interface LiveTestFn {
    (name: string, body: LiveBody): Promise<void>;
    (name: string, options: LiveTestOptions, body: LiveBody): Promise<void>;
}

let collecting = false;
let collected: Promise<readonly LiveSpecimen[]> | undefined;
const specimens: LiveSpecimen[] = [];
const running = new AsyncLocalStorage<LiveSpecimen>();
let routeFacts: Promise<RouteFacts> | undefined;

export const liveTimeoutMs = (): number => {
    const value = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("PLURNK_SERVICE_LIVE_TIMEOUT must be a positive integer in milliseconds");
    return value;
};

// The specimen whose body is running on this async path; the harness names it in the worker's census.
export const currentSpecimen = (): LiveSpecimen | undefined => running.getStore();

// The active route's facts, instantiated once per test process and only when a specimen asks. The
// harness is reached by a computed specifier so that this module, which the drivers and the ACP
// lane import, stays outside the daemon's type graph.
const HARNESS = new URL("./_live-harness.ts", import.meta.url).href;
const facts = (): Promise<RouteFacts> => {
    routeFacts ??= (async () => {
        const { liveProvider } = await import(HARNESS) as { liveProvider: () => Promise<RouteFacts> };
        const provider = await liveProvider();
        return { inputModalities: provider.inputModalities, supportedEfforts: provider.supportedEfforts, outputBudget: provider.outputBudget };
    })();
    return routeFacts;
};

export const liveTest: LiveTestFn = ((name: string, ...args: unknown[]) => {
    const options = (typeof args[0] === "function" ? {} : args[0]) as LiveTestOptions;
    const { requires = [], ...testOptions } = options;
    const specimen: LiveSpecimen = Object.freeze({ name, requires: Object.freeze([...requires]) });
    if (collecting) {
        specimens.push(specimen);
        return undefined;
    }
    const body = args.at(-1) as LiveBody;
    return test(name, { timeout: liveTimeoutMs(), ...testOptions }, (context) => {
        let settled = false;
        let interrupted = false;
        context.signal.addEventListener("abort", () => { interrupted = !settled; }, { once: true });
        const running_ = Promise.resolve().then(async () => {
            // An unmet requirement is a skip that names it, before anything boots or is spent.
            const unmet = await unmetRequirements(specimen.requires, needsRoute(specimen.requires) ? facts : () => { throw new Error("unreachable"); });
            if (unmet.length > 0) { context.skip(unmet.join("; ")); return; }
            await running.run(specimen, () => body(context));
        }).finally(() => { settled = true; });
        // node:test cancels its wait on timeout. Join the signalled body's cleanup
        // before the next specimen starts; the returned promise owns its failure.
        context.after(async () => {
            try { await running_; }
            catch (error) {
                if (interrupted && error !== context.signal.reason) {
                    // The runner reports the original timeout instead of this later failure.
                    console.error("live specimen cancellation did not settle cleanly:", error);
                    throw error;
                }
            }
        });
        return running_;
    });
}) as LiveTestFn;

// Import every tier file once in collection mode: nothing registers with node:test, every specimen
// records its name and requirements.
export const collectLiveSpecimens = (files: readonly string[]): Promise<readonly LiveSpecimen[]> => {
    collected ??= (async () => {
        collecting = true;
        try {
            for (const file of files) await import(pathToFileURL(file).href);
        } finally {
            collecting = false;
        }
        return Object.freeze([...specimens]);
    })();
    return collected;
};

export const collectLiveTestNames = async (files: readonly string[]): Promise<readonly string[]> =>
    Object.freeze((await collectLiveSpecimens(files)).map(({ name }) => name));
