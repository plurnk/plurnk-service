import type { PacketSectionDraft } from "./packet.ts";

const FIELDS = ["name", "slot", "header", "content"] as const;
const FIELD_NAMES = new Set<string>(FIELDS);

export default class PacketSections {
    static assertDrafts(value: unknown, subject = "packet section drafts"): PacketSectionDraft[] {
        if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);

        const names = new Set<string>();
        for (let index = 0; index < value.length; index += 1) {
            const section = PacketSections.#assertDraft(value[index], `${subject}[${index}]`);
            if (names.has(section.name)) {
                throw new TypeError(`${subject} has duplicate section name '${section.name}'`);
            }
            names.add(section.name);
        }
        return value as PacketSectionDraft[];
    }

    static #assertDraft(value: unknown, subject: string): PacketSectionDraft {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new TypeError(`${subject} must be an object`);
        }
        const section = value as Record<string, unknown>;
        const missing = FIELDS.find((field) => !Object.hasOwn(section, field));
        if (missing !== undefined) throw new TypeError(`${subject} is missing field '${missing}'`);
        const unexpected = Object.keys(section).find((field) => !FIELD_NAMES.has(field));
        if (unexpected !== undefined) throw new TypeError(`${subject} has unexpected field '${unexpected}'`);
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
        return value as PacketSectionDraft;
    }
}
