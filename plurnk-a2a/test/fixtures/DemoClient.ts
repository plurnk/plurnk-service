import { randomUUID } from "node:crypto";
import {
    Role,
    type SendMessageRequest,
} from "@a2a-js/sdk";
import { connectHttpJsonAgent } from "../../src/index.ts";

export { connectHttpJsonAgent };

export const textRequest = (text: string): SendMessageRequest => ({
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
        taskId: "",
        contextId: "",
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
    },
    configuration: undefined,
});
