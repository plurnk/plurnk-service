// Permissive structural type for SqlRite-managed database handles. SqlRite
// generates statement-named accessors at runtime (`db.<prep_name>.run/.get/.all`
// per `-- PREP:` blocks in .sql files). `npm run build:types` from
// @possumtech/sqlrite produces precise codegen; this alias is the manual
// fallback typing until that's wired into the build.

export interface PrepMethod {
    run(params?: object): Promise<{ changes: number; lastInsertRowid: number }>;
    get<T = Record<string, unknown>>(params?: object): Promise<T | undefined>;
    all<T = Record<string, unknown>>(params?: object): Promise<T[]>;
}

export type ExecMethod = (params?: object) => Promise<unknown>;

export type Db = {
    close(): Promise<void>;
    ready(): Promise<unknown>;
} & Record<string, PrepMethod | ExecMethod>;
