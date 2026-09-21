import { join, resolve } from "node:path";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";

export const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");

export async function openTestDatabase() {
    const { openMigrated } = await import(join(SERVICE, "test/intg/_helpers.ts"));
    // {§test-artifact-retention} — this lane's run directory, beside every other harness's.
    return openMigrated(join(await testArtifactDirectory("agui"), `db-${crypto.randomUUID()}.db`));
}
