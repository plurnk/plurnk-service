import SqlRiteSync from "@possumtech/sqlrite/sync";

export const readDigestDb = <T>(path: string, read: (db: SqlRiteSync) => T): T => {
    using db = new SqlRiteSync({ path, dir: [import.meta.dirname] });
    return read(db);
};
