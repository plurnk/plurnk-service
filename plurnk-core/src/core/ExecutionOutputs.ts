import { randomBytes } from "node:crypto";
import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import { OutputScheme, type SchemeManifest } from "@plurnk/plurnk-schemes";
import type { Db } from "./Db.ts";
import { entryCoordinateOf } from "./plurnk-uri.ts";

// {§execution-output-identity} Persistence owns output identity, not the executor registry.
export default class ExecutionOutputs {
    static short(): string {
        return randomBytes(4).toString("hex");
    }

    static async claim(db: Db, workspaceId: number, scheme: string): Promise<string> {
        while (true) {
            const pathname = `/${ExecutionOutputs.short()}`;
            const claimed = await db.execution_output_claim.get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });
            if (claimed !== undefined) return pathname;
        }
    }

    static async manifest(db: Db, workspaceId: number, target: ParsedPath): Promise<SchemeManifest | null> {
        if (target.kind !== "url" || target.scheme === null) return null;
        const { authority, pathname } = entryCoordinateOf(target, "namespace");
        const entries = await db.execution_output_describe.all<{ pathname: string; default_channel: string; channel: string; mimetype: string }>({
            workspace_id: workspaceId, scheme: target.scheme, authority,
            pathname: PathSyntax.hasGlob(pathname) || pathname.endsWith("/") ? null : pathname,
        });
        if (entries.length === 0) return null;
        const exact = entries.every((entry) => entry.pathname === pathname);
        return OutputScheme.manifestFromRuntime({
            name: target.scheme,
            channels: exact ? Object.fromEntries(entries.map((entry) => [entry.channel, entry.mimetype])) : {},
            defaultChannel: exact ? entries[0]!.default_channel : "",
        });
    }
}
