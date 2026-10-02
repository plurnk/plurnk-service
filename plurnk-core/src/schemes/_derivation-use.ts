import type { Db } from "../core/Db.ts";

type Usage = { readers: number; collection: Promise<void> | null };

// {§derivation-in-flight}: collection cannot remove a not-yet-attached artifact or its source.
// Uses remain parallel; a busy collector skips this pass, and new uses await an active collector.
export default class DerivationUse {
    static readonly #databases = new WeakMap<Db, Usage>();

    static #usage(db: Db): Usage {
        let usage = DerivationUse.#databases.get(db);
        if (usage === undefined) {
            usage = { readers: 0, collection: null };
            DerivationUse.#databases.set(db, usage);
        }
        return usage;
    }

    static async read<T>(db: Db, action: () => Promise<T>): Promise<T> {
        const usage = DerivationUse.#usage(db);
        while (usage.collection !== null) await usage.collection;
        usage.readers++;
        try { return await action(); }
        finally { usage.readers--; }
    }

    static async collect<T>(db: Db, action: () => Promise<T>): Promise<T | null> {
        const usage = DerivationUse.#usage(db);
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
