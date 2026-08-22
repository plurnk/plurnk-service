import { randomUUID } from "node:crypto";
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
    ): SendMessageRequest {
        return {
            tenant: "",
            metadata: {},
            message: {
                messageId: randomUUID(),
                role: Role.ROLE_USER,
                parts: [{
                    content: { $case: "text", value: text },
                    filename: "",
                    mediaType: "text/plain",
                    metadata: {},
                }],
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
