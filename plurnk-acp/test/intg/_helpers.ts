import { join, resolve } from "node:path";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import type { Db } from "../../../plurnk-core/src/core/Db.ts";

export const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");

export async function openTestDatabase(path?: string): Promise<Db> {
    const { openMigrated }: { openMigrated: (atPath?: string) => Promise<Db> } = await import(
        join(SERVICE, "test/intg/_db.ts")
    );
    return openMigrated(path ?? join(await testArtifactDirectory("acp"), `db-${crypto.randomUUID()}.db`));
}

export async function bindListener(): Promise<{
    httpAddress(): { host: string; port: number };
    close(): Promise<void>;
}> {
    const { default: HttpListener } = await import(join(SERVICE, "src/server/HttpListener.ts"));
    return HttpListener.bind({ host: "127.0.0.1", port: 0 });
}
