import { BaseHandler, type HandlerContent } from "@plurnk/plurnk-mimetypes";

export interface AudioFacts {
    readonly format: string;
    readonly duration: number | null;
    readonly bytes: number;
}

// {§mimetype-audio-facts} — parsing is lazy; concurrent projection hooks share one observation.
export default class Audio extends BaseHandler {
    readonly #observations = new WeakMap<Uint8Array, Promise<AudioFacts>>();

    override async facts(content: HandlerContent): Promise<AudioFacts> {
        if (!(content instanceof Uint8Array)) throw new TypeError("Audio handler receives binary content as a Uint8Array.");
        const previous = this.#observations.get(content);
        if (previous !== undefined) return previous;
        const observation = this.#inspect(content);
        this.#observations.set(content, observation);
        return observation;
    }

    async #inspect(bytes: Uint8Array): Promise<AudioFacts> {
        const { parseBuffer } = await import("music-metadata");
        const { format } = await parseBuffer(bytes, { mimeType: this.mimetype }, {
            duration: true,
            skipCovers: true,
            skipPostHeaders: true,
        });
        if (!format.container || !format.numberOfChannels) throw new SyntaxError("No audio track identified in the source bytes.");
        const duration = typeof format.duration === "number" && Number.isFinite(format.duration) && format.duration >= 0
            ? format.duration : null;
        return { format: format.container, duration, bytes: bytes.byteLength };
    }

    override async validate(content: HandlerContent): Promise<void> {
        await this.facts(content);
    }

    override async content(content: HandlerContent): Promise<string> {
        const facts = await this.facts(content);
        const duration = facts.duration === null ? "" : `, ${facts.duration} s`;
        return `${facts.format} audio${duration}, ${facts.bytes} bytes`;
    }

    override summary(content: HandlerContent): Promise<string> {
        return this.content(content);
    }

    override deepJson(content: HandlerContent): Promise<AudioFacts> {
        return this.facts(content);
    }
}
