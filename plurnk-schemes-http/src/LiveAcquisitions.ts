// One live abort controller per (worker, URL), so a KILL of the address cancels the
// acquisition that worker is holding instead of reaching the remote ({§http-kill}).
export default class LiveAcquisitions {
    readonly #controllers = new Map<string, AbortController>();

    static key(workerId: number, url: string): string {
        return `${workerId}:${url}`;
    }

    static composed(outer: AbortSignal | undefined, local: AbortSignal): AbortSignal {
        return outer === undefined ? local : AbortSignal.any([outer, local]);
    }

    track(key: string, controller: AbortController): () => void {
        this.#controllers.set(key, controller);
        return () => {
            if (this.#controllers.get(key) === controller) this.#controllers.delete(key);
        };
    }

    cancel(key: string): boolean {
        const controller = this.#controllers.get(key);
        if (controller === undefined) return false;
        this.#controllers.delete(key);
        controller.abort();
        return true;
    }
}
