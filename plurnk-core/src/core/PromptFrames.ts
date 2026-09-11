import EntryCrud from "../schemes/_entry-crud.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import WorkerName from "./WorkerName.ts";
import { promptPathname } from "./plurnk-uri.ts";
import { OperationFailureError } from "./results.ts";

// {§prompt-address}: claim new identities atomically; reuse already-published identities.
export default class PromptFrames {
    static async write(ctx: PlurnkSchemeContext, frame: {
        loopSequence: number;
        ordinal: number;
        content: string;
        openPaths: readonly string[];
        source?: string | null;
        pathname?: string | null;
    }): Promise<string> {
        const authority = await WorkerName.forId(ctx.db, ctx.workerId);
        const createOnly = frame.pathname == null;
        while (true) {
            const pathname = frame.pathname ?? promptPathname(frame.loopSequence);
            const result = await EntryCrud.writeEntry({ authority, pathname }, {
                channels: { body: { content: frame.content, mimetype: "text/markdown" } },
                attributes: {
                    ordinal: frame.ordinal,
                    openPaths: frame.openPaths,
                    ...(frame.source == null ? {} : { source: frame.source }),
                },
            }, ctx, "prompt", { createOnly });
            if (createOnly && result.status === 409) continue;
            if (result.status >= 400) throw new OperationFailureError(result);
            return pathname;
        }
    }
}
