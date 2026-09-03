import { Validator, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";

export interface StoredPacketSection extends PacketSectionDraft {
    readonly weight: number;
}

export type PacketAssistant = {
    content: string;
    ops: PlurnkStatement[];
    reasoning: string | null;
};

// {§packet-attachment-parts} — one open READ of an image, weighed and addressable for the wire.
export interface PacketAttachment {
    readonly scheme: string;
    readonly pathname: string;
    readonly mimetype: string;
    readonly kind: "image" | "pdf";
    readonly weight: number;
    readonly width?: number;
    readonly height?: number;
    readonly pages?: number;
}
export type RequestPacket = {
    weight: number;
    sections: StoredPacketSection[];
    attributions: string[];
    attachments?: PacketAttachment[];
};

export type AdmittedPacket = RequestPacket & {
    assistant: PacketAssistant;
    assistantRaw: unknown;
};

export type DurablePacket = RequestPacket | AdmittedPacket;

const own = (value: object, key: string): boolean => Object.hasOwn(value, key);

// {§packet-stored-shape} — the one type and validation boundary for the
// optional model-exchange record stored on a Turn.
export default class StoredPacket {
    static admit(request: RequestPacket, assistant: PacketAssistant, assistantRaw: unknown): AdmittedPacket {
        const packet = StoredPacket.assert({
            ...request,
            assistant,
            assistantRaw: assistantRaw ?? null,
        }, "admitted packet");
        if (!StoredPacket.isAdmitted(packet)) throw new Error("admitted packet lost its response fields");
        return packet;
    }

    static stringify(packet: DurablePacket): string {
        const value = StoredPacket.assert(packet, "packet write");
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new TypeError("packet write is not JSON-serializable");
        StoredPacket.parse(encoded, "packet write");
        return encoded;
    }

    static parse(raw: string | null, subject = "stored packet"): DurablePacket | null {
        if (raw === null) return null;
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch (cause) {
            throw new Error(`${subject} contains invalid JSON`, { cause });
        }
        try {
            return StoredPacket.assert(value, subject);
        } catch (cause) {
            throw new Error(`${subject} has an invalid packet shape`, { cause });
        }
    }

    static #attachments(value: unknown, subject: string): void {
        if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
        value.forEach((item, index) => {
            const attachment = StoredPacket.#record(item, `${subject}[${index}]`) as Record<string, unknown>;
            StoredPacket.#keys(attachment, ["scheme", "pathname", "mimetype", "kind", "weight"], ["scheme", "pathname", "mimetype", "kind", "weight", "width", "height", "pages"], `${subject}[${index}]`);
            for (const key of ["scheme", "pathname", "mimetype"]) {
                if (typeof attachment[key] !== "string" || attachment[key] === "") throw new TypeError(`${subject}[${index}].${key} must be a non-empty string`);
            }
            if (attachment.kind !== "image" && attachment.kind !== "pdf") throw new TypeError(`${subject}[${index}].kind must be "image" or "pdf"`);
            StoredPacket.#nonnegativeInteger(attachment.weight, `${subject}[${index}].weight`);
            for (const key of ["width", "height", "pages"]) {
                if (own(attachment, key)) StoredPacket.#nonnegativeInteger(attachment[key], `${subject}[${index}].${key}`);
            }
        });
    }
    static isAdmitted(packet: DurablePacket): packet is AdmittedPacket {
        return own(packet, "assistant");
    }

    static assert(value: unknown, subject = "packet"): DurablePacket {
        const packet = StoredPacket.#record(value, subject);
        StoredPacket.#keys(
            packet,
            ["weight", "sections", "attributions"],
            ["weight", "sections", "attributions", "attachments", "assistant", "assistantRaw"],
            subject,
        );
        if (own(packet, "attachments")) StoredPacket.#attachments(packet.attachments, `${subject}.attachments`);
        StoredPacket.#nonnegativeInteger(packet.weight, `${subject}.weight`);
        if (!Array.isArray(packet.sections)) throw new TypeError(`${subject}.sections must be an array`);

        const sections = packet.sections.map((section, index) => StoredPacket.#section(section, `${subject}.sections[${index}]`));
        const attributions = StoredPacket.#attributions(packet.attributions, `${subject}.attributions`);
        const hasAssistant = own(packet, "assistant");
        const hasAssistantRaw = own(packet, "assistantRaw");
        if (hasAssistant !== hasAssistantRaw) {
            throw new TypeError(`${subject}.assistant and ${subject}.assistantRaw must be present together`);
        }
        if (!hasAssistant) return { weight: packet.weight as number, sections, attributions };
        if (packet.assistantRaw === undefined) throw new TypeError(`${subject}.assistantRaw must be a JSON value`);

        return {
            weight: packet.weight as number,
            sections,
            attributions,
            assistant: StoredPacket.#assistant(packet.assistant, `${subject}.assistant`),
            assistantRaw: packet.assistantRaw,
        };
    }

    static #assistant(value: unknown, subject: string): PacketAssistant {
        const assistant = StoredPacket.#record(value, subject);
        StoredPacket.#keys(assistant, ["content", "ops", "reasoning"], ["content", "ops", "reasoning"], subject);
        if (typeof assistant.content !== "string") throw new TypeError(`${subject}.content must be a string`);
        if (!Array.isArray(assistant.ops)) throw new TypeError(`${subject}.ops must be an array`);
        if (assistant.reasoning !== null && typeof assistant.reasoning !== "string") {
            throw new TypeError(`${subject}.reasoning must be a string or null`);
        }
        const ops = assistant.ops.map((op, index) => {
            const result = Validator.validatePlurnkStatement(op);
            if (!result.valid) {
                throw new TypeError(`${subject}.ops[${index}] is not a PlurnkStatement: ${JSON.stringify(result.errors)}`);
            }
            return op as PlurnkStatement;
        });
        return { content: assistant.content, ops, reasoning: assistant.reasoning };
    }

    static #section(value: unknown, subject: string): StoredPacketSection {
        const section = StoredPacket.#record(value, subject);
        StoredPacket.#keys(section, ["name", "slot", "header", "content", "weight"], ["name", "slot", "header", "content", "weight"], subject);
        if (typeof section.name !== "string" || section.name.length === 0) {
            throw new TypeError(`${subject}.name must be a non-empty string`);
        }
        if (section.slot !== "system" && section.slot !== "user") {
            throw new TypeError(`${subject}.slot must be system or user`);
        }
        if (section.header !== null && typeof section.header !== "string") {
            throw new TypeError(`${subject}.header must be a string or null`);
        }
        if (typeof section.content !== "string") throw new TypeError(`${subject}.content must be a string`);
        StoredPacket.#nonnegativeInteger(section.weight, `${subject}.weight`);
        return {
            name: section.name,
            slot: section.slot,
            header: section.header,
            content: section.content,
            weight: section.weight as number,
        };
    }

    static #attributions(value: unknown, subject: string): string[] {
        if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
        const tags = value.map((tag, index) => {
            if (typeof tag !== "string" || tag.length === 0) {
                throw new TypeError(`${subject}[${index}] must be a non-empty string`);
            }
            return tag;
        });
        const canonical = [...new Set(tags)].toSorted();
        if (canonical.length !== tags.length || canonical.some((tag, index) => tag !== tags[index])) {
            throw new TypeError(`${subject} must be deduplicated and sorted`);
        }
        return tags;
    }

    static #record(value: unknown, subject: string): Record<string, unknown> {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new TypeError(`${subject} must be an object`);
        }
        return value as Record<string, unknown>;
    }

    static #keys(value: Record<string, unknown>, required: string[], allowed: string[], subject: string): void {
        for (const key of required) {
            if (!own(value, key)) throw new TypeError(`${subject}.${key} is required`);
        }
        const extras = Object.keys(value).filter((key) => !allowed.includes(key));
        if (extras.length > 0) throw new TypeError(`${subject} has unknown fields: ${extras.join(", ")}`);
    }

    static #nonnegativeInteger(value: unknown, subject: string): asserts value is number {
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
            throw new TypeError(`${subject} must be a non-negative safe integer`);
        }
    }
}
