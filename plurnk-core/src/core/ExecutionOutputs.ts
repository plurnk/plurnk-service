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

    static async claim(db: Db, workspaceId: number, runtime: string): Promise<string> {
        const prefix = runtime === "" ? "sh" : runtime;
        while (true) {
            const pathname = `/${prefix}/${ExecutionOutputs.short()}`;
            const claimed = await db.execution_output_claim.get<{ id: number }>({ workspace_id: workspaceId, pathname });
            if (claimed !== undefined) return pathname;
        }
    }

    static async manifest(db: Db, workspaceId: number, target: ParsedPath): Promise<SchemeManifest | null> {
        if (target.kind !== "url" || target.scheme !== "exec") return null;
        const { authority, pathname } = entryCoordinateOf(target, "namespace");
        const entries = await db.execution_output_describe.all<{ pathname: string; default_channel: string; channel: string; mimetype: string }>({
            workspace_id: workspaceId, authority,
            pathname: PathSyntax.hasGlob(pathname) || pathname.endsWith("/") || pathname === "" ? null : pathname,
        });
        if (entries.length === 0) return null;
        const exact = entries.every((entry) => entry.pathname === pathname);
        return {
            ...OutputScheme.manifestFromRuntime({
                name: "exec",
                channels: exact ? Object.fromEntries(entries.map((entry) => [entry.channel, entry.mimetype])) : {},
                defaultChannel: exact ? entries[0].default_channel : "",
            }),
            writableBy: ["_plurnk"],
            volatile: false,
        };
    }
}
