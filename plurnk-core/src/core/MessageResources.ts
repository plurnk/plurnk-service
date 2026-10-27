import { randomBytes } from "node:crypto";
import { lifecycleOfLoopStatus, type ApplicationInboxMessage, type ApplicationMessage, type MessageEvidence, type MessageResource, type MessageResourceReceipt } from "@plurnk/plurnk-contracts";
import { ResourceNames } from "@plurnk/plurnk-schemes";
import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import NativeContent from "./NativeContent.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import Results, { OperationFailureError } from "./results.ts";

export default class MessageResources {
    static async publish(body: string, resources: readonly MessageResource[], ctx: PlurnkSchemeContext): Promise<{ body: string; attachments: MessageResourceReceipt[] }> {
        if (resources.length === 0) return { body, attachments: [] };
        const session = await ctx.db.session_get.get<{ name: string }>({ id: ctx.sessionId });
        if (session === undefined) throw new Error(`Message recipient ${ctx.sessionId} is absent.`);
        const names = new ResourceNames();
        const directory = `/attachments/${randomBytes(4).toString("hex")}`;
        const attachments: MessageResourceReceipt[] = [];
        const links: string[] = [];
        for (const [index, resource] of resources.entries()) {
            const contentHash = await NativeContent.retain(ctx.db, resource.bytes);
            const name = names.allocate(resource.name, `${contentHash}/${index}`);
            const pathname = `${directory}/${name}`;
            const written = await EntryCrud.writeEntry({ authority: session.name, pathname }, {
                channels: { body: { content: "", bytes: resource.bytes, mimetype: resource.mediaType } },
            }, ctx, "session");
            if (written.status >= 400) throw new OperationFailureError(written);
            const target = `session://${session.name}${pathname}`;
            attachments.push({ name: resource.name || decodeURIComponent(name), mediaType: resource.mediaType, contentHash, target });
            links.push(`<${target}>`);
        }
        return { body: [body, ...links].filter((part) => part.length > 0).join("\n\n"), attachments };
    }

    // {§methods} A client message's address is its idempotency key ({§message-source-scheme}): new when
    // nothing is accepted there, accepted when the same body is, and refused when another body is.
    static async admission(db: Db, workspaceId: number, address: string, body: string): Promise<"new" | "accepted"> {
        const accepted = await db.message_source_by_address.get<{ body: string; loop_id: number }>({ workspace_id: workspaceId, path: address });
        if (accepted === undefined) return "new";
        if (accepted.body === body) return "accepted";
        throw MessageResources.reused(address, accepted.loop_id);
    }

    // {§methods} The key reused for another payload.
    static reused(address: string, loopId: number): OperationFailureError {
        return new OperationFailureError(Results.failure(
            "daemon:admission", "message-address-reused", 422,
            "This message address was already accepted in this workspace with other words.",
            {}, { address, loopId, retryable: false },
        ));
    }

    // {§methods} The accepted messages the session has not yet observed ({§message-arrival}): durable the
    // moment they are accepted, published at the next turn boundary of the loop holding them, which a terminal loop
    // never reaches.
    static async inbox(db: Db, args: { workspaceId: number; sessionId: number }): Promise<ApplicationInboxMessage[]> {
        const rows = await db.message_inbox.all<{ path: string; source: string | null; body: string; loop_id: number; loop_status: number }>({
            workspace_id: args.workspaceId, session_id: args.sessionId,
        });
        return rows.map(({ path, source, body, loop_id, loop_status }) => ({ path, source, body, loopId: loop_id, lifecycle: lifecycleOfLoopStatus(loop_status) }));
    }

    static async read(db: Db, args: { workspaceId: number; sessionId: number; loopId?: number }): Promise<ApplicationMessage[]> {
        const rows = await db.message_history.all<{
            id: number; loop_id: number; direction: "inbound" | "outbound"; source: string | null; body: string; evidence: string; answers: string;
        }>({ workspace_id: args.workspaceId, session_id: args.sessionId, loop_id: args.loopId ?? null });
        return Promise.all(rows.map(async (row) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: a message's evidence is read back as the row stored it
            const evidence = JSON.parse(row.evidence) as MessageEvidence;
            const attachments = await Promise.all((evidence.attachments ?? []).map(async (receipt) => ({
                name: receipt.name, mediaType: receipt.mediaType, target: receipt.target,
                bytes: await NativeContent.read(db, receipt.contentHash),
            })));
            return { id: row.id, loopId: row.loop_id, direction: row.direction, source: row.source, body: row.body,
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: a message's answers are read back as the row stored them
                answers: JSON.parse(row.answers) as string[],
                ...(evidence.envelope === undefined ? {} : { envelope: evidence.envelope }), attachments };
        }));
    }
}
