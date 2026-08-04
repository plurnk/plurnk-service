import { join, resolve } from "node:path";

export const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");
const ARTIFACTS = resolve(import.meta.dirname, ".tmp");

export async function openTestDatabase() {
    const { openMigrated } = await import(join(SERVICE, "test/intg/_helpers.ts"));
    return openMigrated(join(ARTIFACTS, `db-${crypto.randomUUID()}.db`));
}
