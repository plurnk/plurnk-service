import { Knob } from "@plurnk/plurnk-meta";

// {§crash-only-stop}: one absolute budget across daemon drains and enclosing resource cleanup.
export default class StopDeadline {
    readonly #expires = Date.now() + Knob.integer("PLURNK_SERVICE_STOP_TIMEOUT_MS", 1);

    settle<T>(label: string, wait: () => Promise<T>): Promise<PromiseSettledResult<T>> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: PromiseSettledResult<T>): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(
                () => finish({ status: "rejected", reason: new Error(`stop deadline exceeded waiting for ${label}`) }),
                Math.max(0, this.#expires - Date.now()),
            );
            Promise.resolve().then(wait).then(
                (value) => finish({ status: "fulfilled", value }),
                (reason: unknown) => finish({ status: "rejected", reason }),
            );
        });
    }
}
