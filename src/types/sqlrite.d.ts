// Type declaration for @possumtech/sqlrite, which ships as plain JS.
// The runtime API surface is dynamic: PREP-block names become accessor
// properties at db open. The Db type in src/core/Db.ts is the precise
// structural shape this project uses; this declaration just satisfies
// the module-resolution requirement so the default import compiles.

declare module "@possumtech/sqlrite" {
    interface SqlRiteOpenOptions {
        path?: string;
        dir?: string | string[];
        functions?: string | string[];
        params?: Record<string, string | number | null>;
    }

    interface SqlRiteInstance {
        ready(): Promise<unknown>;
        close(): Promise<void>;
        [methodName: string]: unknown;
    }

    interface SqlRiteStatic {
        open(options: SqlRiteOpenOptions): Promise<SqlRiteInstance>;
    }

    const SqlRite: SqlRiteStatic;
    export default SqlRite;
}

// The sync variant (SqlRiteSync.js) — CLI/scripts. Same dynamic-accessor shape;
// statement methods are synchronous, plus a transaction([...]) snapshot helper.
// bin/digest.ts is the consumer; src/core/Db.ts stays the precise async handle.
declare module "@possumtech/sqlrite/sync" {
    interface SqlRiteSyncOpenOptions {
        path?: string;
        dir?: string | string[];
        functions?: string | string[];
        params?: Record<string, string | number | null>;
    }

    interface SqlRiteSyncInstance {
        close(): void;
        transaction(calls: Array<{ name: string; params?: object; mode?: "all" | "get" | "run" }>): unknown[];
        [methodName: string]: unknown;
    }

    interface SqlRiteSyncStatic {
        open(options: SqlRiteSyncOpenOptions): Promise<SqlRiteSyncInstance>;
    }

    const SqlRiteSync: SqlRiteSyncStatic;
    export default SqlRiteSync;
}
