// {§http-kill} Addressed cancellation reaches every local acquisition of the resource.
export default class LiveAcquisitions {
    readonly #controllers = new Map<string, Set<AbortController>>();

    static key(workspaceId: number, url: string): string {
        return `${workspaceId}:${url}`;
    }

    static composed(outer: AbortSignal | undefined, local: AbortSignal): AbortSignal {
        return outer === undefined ? local : AbortSignal.any([outer, local]);
    }

    track(key: string, controller: AbortController): () => void {
        const controllers = this.#controllers.get(key) ?? new Set<AbortController>();
        controllers.add(controller);
        this.#controllers.set(key, controllers);
        return () => {
            controllers.delete(controller);
            if (controllers.size === 0 && this.#controllers.get(key) === controllers) this.#controllers.delete(key);
        };
    }

    cancel(key: string): boolean {
        const controllers = this.#controllers.get(key);
        if (controllers === undefined) return false;
        this.#controllers.delete(key);
        for (const controller of controllers) controller.abort();
        return true;
    }
}
