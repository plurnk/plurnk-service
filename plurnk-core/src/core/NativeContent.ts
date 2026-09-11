import { createHash } from "node:crypto";
import type { Db } from "./Db.ts";

// {§packet-attachment-parts}: immutable bytes are shared; each READ owns its observation.
export default class NativeContent {
    static async retain(db: Db, content: Uint8Array): Promise<string> {
        const hash = createHash("sha256").update(content).digest("hex");
        await db.native_content_retain.run({ hash, content });
        return hash;
    }

    static async read(db: Db, hash: string): Promise<Uint8Array> {
        const row = await db.native_content_read.get<{ content: Uint8Array }>({ hash });
        if (row === undefined) throw new Error(`Missing immutable native content ${hash}.`);
        return row.content;
    }
}
