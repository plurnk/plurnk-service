import { createHash, randomUUID } from "node:crypto";

// {§resource-publication-names} One allocator per resource collection. A stable
// identity lets a live collection reconstruct its paths on subsequent READs.
export default class ResourceNames {
    readonly #used = new Set<string>();

    allocate(name?: string, identity: string = randomUUID()): string {
        const supplied = name === undefined || name === "" || name === "." || name === ".." ? null : name;
        let attempt = 0;
        const hash = (): string => createHash("sha256").update(identity).update(`\0${attempt++}`).digest("hex").slice(0, 8);
        let candidate = supplied ?? hash();
        while (this.#used.has(candidate)) candidate = `${supplied === null ? "" : `${supplied}.`}${hash()}`;
        this.#used.add(candidate);
        return encodeURIComponent(candidate).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    }
}
