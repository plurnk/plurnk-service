import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { contentHash } from "../core/content-hash.ts";

// {§readable-channel} — a readable projection is a channel, never a hidden matching surface.
// When an entry's source channel lands, the handler's readable projection (when it has one)
// lands beside it as `readable`, text/markdown, in its own coordinates; when the source has
// no projection, no sibling remains. Nothing else writes this channel.
export default class EntryReadable {
    static readonly CHANNEL = "readable";
    static readonly MIMETYPE = "text/markdown";

    static isDerived(channel: string): boolean {
        return channel === EntryReadable.CHANNEL;
    }

    // Refresh the sibling after `channel` of `entryId` landed with `content`. Only the entry's
    // default channel is a source; a non-default write leaves the sibling alone.
    static async sync(
        ctx: PlurnkSchemeContext,
        entryId: number,
        channel: string,
        defaultChannel: string,
        content: string,
        mimetype: string,
    ): Promise<void> {
        if (channel !== defaultChannel || EntryReadable.isDerived(channel)) return;
        const { db, mimetypes, weigh } = ctx;
        // Administrative writes (prompt frames, drains) carry no registry and write text that
        // never projects; the sibling is a registry-backed fact, so without one nothing is derived.
        if (mimetypes === undefined) return;
        if (weigh === undefined) throw new Error("EntryReadable.sync: ctx.weigh is required for curation-weight accounting");
        const projected = content.length === 0 ? null : await mimetypes.projectReadable({ content, hint: mimetype });
        if (projected === null || projected.content === content) {
            await db.crud_delete_readable_channel.run({ entry_id: entryId });
            return;
        }
        await db.crud_upsert_readable_channel.run({
            entry_id: entryId,
            content: projected.content,
            mimetype: EntryReadable.MIMETYPE,
            weight: weigh(projected.content),
            content_hash: contentHash(projected.content),
        });
    }
}
