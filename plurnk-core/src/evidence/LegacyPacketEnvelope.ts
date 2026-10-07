import type { ChatMessage } from "@plurnk/plurnk-providers";
import type { RequestPacket } from "../core/StoredPacket.ts";
import PacketWire from "../core/packet-wire.ts";

// {§packet-wire-envelope}: read-only interpretation of captures predating the previous-emission
// section. Never used to construct a live request; historical captures retain their original roles.
export default class LegacyPacketEnvelope {
    static packetToWireMessages(packet: Pick<RequestPacket, "sections">, emissions: ReadonlyMap<string, string>): Array<ChatMessage & { content: string }> {
        const sections = packet.sections ?? [];
        const messages: Array<ChatMessage & { content: string }> = [{ role: "system", content: PacketWire.renderSlot(sections, "system") }];
        let pending: string[] = [];
        for (const section of sections) {
            if (section.slot !== "user") continue;
            const rendered = PacketWire.renderSection(section);
            if (rendered.length === 0) continue;
            if (section.name !== "log") {
                pending.push(rendered);
                continue;
            }
            for (const { content, coordinate } of LegacyPacketEnvelope.#logRecords(rendered)) {
                pending.push(content);
                const frozen = coordinate === null ? undefined : emissions.get(coordinate);
                const emission = frozen === undefined ? "" : LegacyPacketEnvelope.deliveredEmission(frozen);
                if (emission.length === 0) continue;
                messages.push({ role: "user", content: pending.join("\n\n") });
                messages.push({ role: "assistant", content: emission });
                pending = [];
            }
        }
        const closing = pending.join("\n\n");
        if (closing.length === 0 && messages.at(-1)?.role === "assistant") throw new Error("a request never ends on an emission: nothing follows the last one");
        messages.push({ role: "user", content: closing });
        return messages;
    }

    // Preserve the released redaction, including its empty-body defect, as historical evidence.
    static deliveredEmission(frozen: string): string {
        const lines = frozen.split("\n");
        const kept: string[] = [];
        for (let index = 0; index < lines.length;) {
            const fence = /^`{3,}/u.exec(lines[index]!)?.[0];
            if (fence === undefined) throw new Error(`an emission block opens with a fence, not ${JSON.stringify(lines[index])}`);
            const end = lines.findIndex((line, at) => at > index && (line === fence || line.startsWith(`${fence} <!-- `)));
            if (end === -1) throw new Error("an emission block closes with its own fence");
            const heading = lines[index]!;
            if (!new RegExp(`^${fence}(?:(?:NOTE|WAIT)\\b|(?:KILL|SEND)(?:\\s+<!--.*-->)?\\s*$)`, "u").test(heading)) {
                kept.push(end > index + 1 ? `${heading}\n${fence}` : `${heading}${fence}`);
            }
            index = end + 2;
        }
        return kept.join("\n\n");
    }

    static #logRecords(rendered: string): Array<{ content: string; coordinate: string | null; leaf: string | null }> {
        return rendered.split(/\n\n(?=### log:\/\/\/)/u).map((content) => {
            const match = /^### log:\/\/\/(\d+\/\d+\/\d+)(?:\/(\S*))?(?=\s|$)/mu.exec(content);
            return { content, coordinate: match?.[1] ?? null, leaf: match?.[2] ?? null };
        });
    }
}
