import { join, resolve } from "node:path";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import type { Db } from "../../../plurnk-core/src/core/Db.ts";

export const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");

export async function openTestDatabase(path?: string): Promise<Db> {
    const { openMigrated }: { openMigrated: (atPath?: string) => Promise<Db> } = await import(join(SERVICE, "test/intg/_db.ts"));
    // {§test-artifact-retention} — this lane's run directory, beside every other harness's.
    return openMigrated(path ?? join(await testArtifactDirectory("agui"), `db-${crypto.randomUUID()}.db`));
}

// {§agui-daemon-client} — the daemon's one listener, bound before the daemon exists as the service
// binds it ({§startup-listener-admission}); the daemon discovers this module and mounts it at /agui.
export async function bindListener(): Promise<{ httpAddress(): { host: string; port: number }; close(): Promise<void> }> {
    const { default: HttpListener } = await import(join(SERVICE, "src/server/HttpListener.ts"));
    return HttpListener.bind({ host: "127.0.0.1", port: 0 });
}

// {§agui-body-reference} A result as an ordinary client reads it: its receipt, and its body fetched from the document part
// that carries it; a result without a body is its receipt alone.
export async function resultOf(content: unknown): Promise<{ receipt: Record<string, unknown>; body: string | null }> {
    if (typeof content === "string") return { receipt: JSON.parse(content) as Record<string, unknown>, body: null };
    const parts = content as ReadonlyArray<{ type: string; text?: string; source?: { type: string; value?: string } }>;
    const text = parts.find((part) => part.type === "text")?.text;
    const source = parts.find((part) => part.type === "document")?.source;
    if (text === undefined || source?.type !== "url" || source.value === undefined) throw new TypeError("A result's parts are its receipt's text and its body's document.");
    const fetched = await fetch(source.value);
    if (fetched.status !== 200) throw new Error(`the body at ${source.value} answered ${fetched.status}`);
    return { receipt: JSON.parse(text) as Record<string, unknown>, body: await fetched.text() };
}
