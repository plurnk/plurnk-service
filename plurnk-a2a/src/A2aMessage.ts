import { randomUUID } from "node:crypto";
import type { MessageResource } from "@plurnk/plurnk-contracts";
import {
    Role,
    type SendMessageRequest,
} from "@a2a-js/sdk";

export interface A2aMessageIdentity {
    readonly taskId?: string;
    readonly contextId?: string;
}

/** Build the canonical text Message used by Plurnk's A2A SEND surface. */
export default class A2aMessage {
    static request(
        text: string,
        identity: A2aMessageIdentity = {},
        attachments: readonly MessageResource[] = [],
    ): SendMessageRequest {
        return {
            tenant: "",
            metadata: {},
            message: {
                messageId: randomUUID(),
                role: Role.ROLE_USER,
                parts: [...(text.length === 0 ? [] : [{
                    content: { $case: "text" as const, value: text },
                    filename: "",
                    mediaType: "text/plain",
                    metadata: {},
                }]), ...attachments.map((attachment) => ({
                    content: { $case: "raw" as const, value: Buffer.from(attachment.bytes) },
                    filename: attachment.name,
                    mediaType: attachment.mediaType,
                    metadata: {},
                }))],
                taskId: identity.taskId ?? "",
                contextId: identity.contextId ?? "",
                extensions: [],
                metadata: {},
                referenceTaskIds: [],
            },
            configuration: undefined,
        };
    }
}
