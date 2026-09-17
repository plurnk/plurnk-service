import { PathSyntax, type SendStatement } from "@plurnk/plurnk-contracts";
import type { MessageCaps } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import EntryCrud from "../../schemes/_entry-crud.ts";
import Results from "../results.ts";

export default class DbMessageCaps implements MessageCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;

    constructor(ctx: PlurnkSchemeContext, scheme: string) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    async prepare(target?: string) {
        const rows = await this.#ctx.db.message_source_resources.all<{ path: string; body: string }>({
            workspace_id: this.#ctx.workspaceId, scheme: this.#scheme, target: target ?? null,
        });
        if (target !== undefined && rows.length === 0) return Results.failure(
            `scheme:${this.#scheme}`, "message-not-found", 404,
            `No accepted message exists at ${target}.`, {}, { retryable: false },
        );
        for (const { path, body } of rows) {
            const uri = new URL(path);
            const address = { authority: uri.host, pathname: PathSyntax.decodeParens(uri.pathname) + uri.search };
            const existing = await EntryCrud.readEntry(address, this.#ctx, this.#scheme);
            if (existing.status === 200) continue;
            if (existing.status !== 404) return existing;
            const written = await EntryCrud.writeEntry(address, {
                channels: { body: { content: body, mimetype: "text/markdown" } },
            }, this.#ctx, this.#scheme);
            if (written.status >= 400) return written;
        }
        return { status: 200 };
    }

    async reply(statement: SendStatement) {
        if (this.#ctx.replyToMessage === undefined) throw new Error("Message replies require a dispatcher context.");
        return this.#ctx.replyToMessage(statement);
    }
}
