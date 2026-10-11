import type { Db } from "./Db.ts";

type Usage = { readers: number; collection: Promise<void> | null };

// {§derivation-in-flight}, {§native-content-lifetime}: collection cannot remove
// a not-yet-published artifact or its source. This grants no resource ownership.
// Uses remain parallel; a busy collector skips this pass, and new uses await an active collector.
export default class ContentUse {
    static readonly #databases = new WeakMap<Db, Usage>();

    static #usage(db: Db): Usage {
        let usage = ContentUse.#databases.get(db);
        if (usage === undefined) {
            usage = { readers: 0, collection: null };
            ContentUse.#databases.set(db, usage);
        }
        return usage;
    }

    static async read<T>(db: Db, action: () => Promise<T>): Promise<T> {
        const usage = ContentUse.#usage(db);
        while (usage.collection !== null) await usage.collection;
        usage.readers++;
        try { return await action(); }
        finally { usage.readers--; }
    }

    static async collect<T>(db: Db, action: () => Promise<T>): Promise<T | null> {
        const usage = ContentUse.#usage(db);
        if (usage.readers > 0 || usage.collection !== null) return null;
        const barrier = Promise.withResolvers<void>();
        usage.collection = barrier.promise;
        try { return await action(); }
        finally {
            usage.collection = null;
            barrier.resolve();
        }
    }
}
