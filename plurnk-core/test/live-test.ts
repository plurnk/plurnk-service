import test, { type TestContext, type TestOptions } from "node:test";
import { pathToFileURL } from "node:url";

let collecting = false;
let collected: Promise<readonly string[]> | undefined;
const names: string[] = [];

export const liveTimeoutMs = (): number => {
    const value = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("PLURNK_SERVICE_LIVE_TIMEOUT must be a positive integer in milliseconds");
    return value;
};

export const liveTest: typeof test = ((name: string, ...args: unknown[]) => {
    if (collecting) {
        names.push(name);
        return undefined;
    }
    const options = typeof args[0] === "function" ? {} : args[0] as TestOptions;
    const body = args.at(-1) as (context: TestContext) => void | Promise<void>;
    return test(name, { timeout: liveTimeoutMs(), ...options }, (context) => {
        let settled = false;
        let interrupted = false;
        context.signal.addEventListener("abort", () => { interrupted = !settled; }, { once: true });
        const running = Promise.resolve().then(() => body(context)).finally(() => { settled = true; });
        // node:test cancels its wait on timeout. Join the signalled body's cleanup
        // before the next specimen starts; the returned promise owns its failure.
        context.after(async () => {
            try { await running; }
            catch (error) {
                if (interrupted && error !== context.signal.reason) {
                    // The runner reports the original timeout instead of this later failure.
                    console.error("live specimen cancellation did not settle cleanly:", error);
                    throw error;
                }
            }
        });
        return running;
    });
}) as typeof test;

export const collectLiveTestNames = (files: readonly string[]): Promise<readonly string[]> => {
    collected ??= (async () => {
        collecting = true;
        try {
            for (const file of files) await import(pathToFileURL(file).href);
        } finally {
            collecting = false;
        }
        return Object.freeze([...names]);
    })();
    return collected;
};
