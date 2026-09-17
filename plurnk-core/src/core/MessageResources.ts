import { randomBytes } from "node:crypto";
import type { ApplicationMessage, MessageEvidence, MessageResource, MessageResourceReceipt } from "@plurnk/plurnk-contracts";
import { ResourceNames } from "@plurnk/plurnk-schemes";
import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import NativeContent from "./NativeContent.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import { OperationFailureError } from "./results.ts";

export default class MessageResources {
    static async publish(body: string, resources: readonly MessageResource[], ctx: PlurnkSchemeContext): Promise<{ body: string; attachments: MessageResourceReceipt[] }> {
        if (resources.length === 0) return { body, attachments: [] };
        const worker = await ctx.db.worker_get.get<{ name: string }>({ id: ctx.workerId });
        if (worker === undefined) throw new Error(`Message recipient ${ctx.workerId} is absent.`);
        const names = new ResourceNames();
        const directory = `/attachments/${randomBytes(4).toString("hex")}`;
        const attachments: MessageResourceReceipt[] = [];
        const links: string[] = [];
        for (const [index, resource] of resources.entries()) {
            const contentHash = await NativeContent.retain(ctx.db, resource.bytes);
            const name = names.allocate(resource.name, `${contentHash}/${index}`);
            const pathname = `${directory}/${name}`;
            const written = await EntryCrud.writeEntry({ authority: worker.name, pathname }, {
                channels: { body: { content: "", bytes: resource.bytes, mimetype: resource.mediaType } },
            }, ctx, "worker");
            if (written.status >= 400) throw new OperationFailureError(written);
            const target = `worker://${worker.name}${pathname}`;
            attachments.push({ name: resource.name || decodeURIComponent(name), mediaType: resource.mediaType, contentHash, target });
            links.push(`<${target}>`);
        }
        return { body: [body, ...links].filter((part) => part.length > 0).join("\n\n"), attachments };
    }

    static async read(db: Db, args: { workspaceId: number; workerId: number; loopId?: number }): Promise<ApplicationMessage[]> {
        const rows = await db.message_history.all<{
            id: number; loop_id: number; direction: "inbound" | "outbound"; source: string | null; body: string; evidence: string; answers: string;
        }>({ workspace_id: args.workspaceId, worker_id: args.workerId, loop_id: args.loopId ?? null });
        return Promise.all(rows.map(async (row) => {
            const evidence = JSON.parse(row.evidence) as MessageEvidence;
            const attachments = await Promise.all((evidence.attachments ?? []).map(async (receipt) => ({
                name: receipt.name, mediaType: receipt.mediaType, target: receipt.target,
                bytes: await NativeContent.read(db, receipt.contentHash),
            })));
            return { id: row.id, loopId: row.loop_id, direction: row.direction, source: row.source, body: row.body,
                answers: JSON.parse(row.answers) as string[],
                ...(evidence.envelope === undefined ? {} : { envelope: evidence.envelope }), attachments };
        }));
    }
}
