import type { MessageResource, MessageResourceReceipt } from "@plurnk/plurnk-contracts";
import MetadataOptions from "./MetadataOptions.ts";
import Results, { type SchemeResult } from "./Results.ts";
import type { ResourceCaps } from "./ctx.ts";

/** Message recipients opt in; HTTP and stdin metadata are not interpreted here. */
export default class MessageAttachments {
    static async capture(metadata: readonly string[] | null, resources: ResourceCaps, owner: string): Promise<
        { readonly attachments: readonly (MessageResource & MessageResourceReceipt)[] } | { readonly failure: SchemeResult }
    > {
        const parsed = MetadataOptions.parse(metadata, owner);
        if ("failure" in parsed) return parsed;
        if (Object.keys(parsed.options).some((key) => key !== "attachments")) {
            return { failure: Results.failure(owner, "metadata-unsupported", 400, "Message metadata accepts only attachments.", {}, { retryable: false }) };
        }
        const targets = parsed.options.attachments === undefined ? [] : parsed.options.attachments;
        if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string" || target.trim().length === 0)) {
            return { failure: Results.failure(owner, "attachments-invalid", 400, "attachments must be an array of non-empty resource addresses.", {}, { retryable: false }) };
        }
        return targets.length === 0 ? { attachments: [] } : resources.capture(targets);
    }

    static receipts(attachments: readonly (MessageResource & MessageResourceReceipt)[]): MessageResourceReceipt[] {
        return attachments.map(({ name, mediaType, contentHash, target }) => ({ name, mediaType, contentHash, ...(target === undefined ? {} : { target }) }));
    }
}
