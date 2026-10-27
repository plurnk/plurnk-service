import { isRecord } from "@plurnk/plurnk-contracts";

// {§network-address} — public authoring surface for trusted packet
// transforms. Measurement remains core-owned.
export interface PacketSectionDraft {
    readonly name: string;
    readonly slot: "system" | "user" | "assistant";
    readonly header: string | null;
    readonly content: string;
}

export interface PacketSectionTransformer {
    transformSections(sections: PacketSectionDraft[]): PacketSectionDraft[] | Promise<PacketSectionDraft[]>;
}

const FIELDS = ["name", "slot", "header", "content"] as const;
const FIELD_NAMES = new Set<string>(FIELDS);

export default class PacketSections {
    // {§network-address} Exact valid drafts preserve their list: the check narrows the value it was given.
    static assertDrafts(value: unknown, subject = "packet section drafts"): PacketSectionDraft[] {
        PacketSections.#checkDrafts(value, subject);
        return value;
    }

    static #checkDrafts(value: unknown, subject: string): asserts value is PacketSectionDraft[] {
        if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);

        const names = new Set<string>();
        for (let index = 0; index < value.length; index += 1) {
            const section = PacketSections.assertDraft(value[index], `${subject}[${index}]`);
            if (names.has(section.name)) {
                throw new TypeError(`${subject} has duplicate section name '${section.name}'`);
            }
            names.add(section.name);
        }
    }

    static assertDraft(value: unknown, subject: string): PacketSectionDraft {
        PacketSections.#checkDraft(value, subject);
        return value;
    }

    // Every field a draft names is checked here; the draft is the value that passed.
    static #checkDraft(value: unknown, subject: string): asserts value is PacketSectionDraft {
        if (!isRecord(value)) {
            throw new TypeError(`${subject} must be an object`);
        }
        const section = value;
        const missing = FIELDS.find((field) => !Object.hasOwn(section, field));
        if (missing !== undefined) throw new TypeError(`${subject} is missing field '${missing}'`);
        const unexpected = Object.keys(section).find((field) => !FIELD_NAMES.has(field));
        if (unexpected !== undefined) throw new TypeError(`${subject} has unexpected field '${unexpected}'`);
        if (typeof section.name !== "string" || section.name.length === 0) {
            throw new TypeError(`${subject}.name must be a non-empty string`);
        }
        if (section.slot !== "system" && section.slot !== "user" && section.slot !== "assistant") {
            throw new TypeError(`${subject}.slot must be system, user or assistant`);
        }
        if (section.header !== null && typeof section.header !== "string") {
            throw new TypeError(`${subject}.header must be a string or null`);
        }
        if (typeof section.content !== "string") throw new TypeError(`${subject}.content must be a string`);
    }
}
