import { join, resolve } from "node:path";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";

export const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");

export async function openTestDatabase() {
    const { openMigrated } = await import(join(SERVICE, "test/intg/_db.ts"));
    // {§test-artifact-retention} — this lane's run directory, beside every other harness's.
    return openMigrated(join(await testArtifactDirectory("agui"), `db-${crypto.randomUUID()}.db`));
}

// {§agui-daemon-client} — the daemon's one listener, bound before the daemon exists as the service
// binds it ({§startup-listener-admission}); the daemon discovers this module and mounts it at /agui.
export async function bindListener(): Promise<{ httpAddress(): { host: string; port: number }; close(): Promise<void> }> {
    const { default: HttpListener } = await import(join(SERVICE, "src/server/HttpListener.ts"));
    return HttpListener.bind({ host: "127.0.0.1", port: 0 });
}
