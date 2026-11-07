import type { MessageResource, MessageResourceReceipt } from "@plurnk/plurnk-contracts";
import Results, { type SchemeResult } from "./Results.ts";
import type { ResourceCaps } from "./ctx.ts";

/** Message recipients opt in; HTTP headers are not interpreted here. */
export default class MessageAttachments {
    static async capture(attachments: readonly string[] | null, resources: ResourceCaps, owner: string): Promise<
        { readonly attachments: readonly (MessageResource & MessageResourceReceipt)[] } | { readonly failure: SchemeResult }
    > {
        if (attachments === null) return { attachments: [] };
        if (!Array.isArray(attachments) || attachments.some((target) => typeof target !== "string" || target.trim().length === 0)) {
            return { failure: Results.failure(owner, "attachments-invalid", 400, "attachments must be an array of non-empty resource addresses.", {}, { retryable: false }) };
        }
        return attachments.length === 0 ? { attachments: [] } : resources.capture(attachments);
    }

    static receipts(attachments: readonly (MessageResource & MessageResourceReceipt)[]): MessageResourceReceipt[] {
        return attachments.map(({ name, mediaType, contentHash, target }) => ({ name, mediaType, contentHash, ...(target === undefined ? {} : { target }) }));
    }
}
