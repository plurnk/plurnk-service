import test from "node:test";
import { pathToFileURL } from "node:url";

let collecting = false;
let collected: Promise<readonly string[]> | undefined;
const names: string[] = [];

export const liveTest: typeof test = ((name: string, ...args: unknown[]) => {
    if (collecting) {
        names.push(name);
        return undefined;
    }
    return Reflect.apply(test, undefined, [name, ...args]);
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
