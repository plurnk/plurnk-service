import type { ReadResourceResult } from "@modelcontextprotocol/client";
import type { EntryData } from "@plurnk/plurnk-schemes";

type ResourceContents = ReadResourceResult["contents"][number];

export default class ResourceContent {
    static name(resource: ResourceContents): string | undefined {
        const { pathname } = new URL(resource.uri);
        if (!pathname.startsWith("/")) return undefined;
        const name = pathname.split("/").at(-1);
        return name ? decodeURIComponent(name) : undefined;
    }

    static channel(resource: ResourceContents): EntryData["channels"][string] {
        return "text" in resource
            ? { content: resource.text, mimetype: resource.mimeType ?? "text/plain" }
            : { content: "", bytes: Buffer.from(resource.blob, "base64"), mimetype: resource.mimeType ?? "application/octet-stream" };
    }
}
