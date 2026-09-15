import type { ContentBlock, ResourceLink, TextContent } from "@modelcontextprotocol/client";
import type { EntryData } from "@plurnk/plurnk-schemes";
import ResourceContent from "./ResourceContent.ts";

interface ResourceProjection {
    address(uri: string): string | Promise<string>;
    publish?(channel: EntryData["channels"][string], name?: string): Promise<string>;
}

export default class ContentProjection {
    static async project(part: ContentBlock, resources: ResourceProjection): Promise<TextContent | ResourceLink> {
        if (part.type === "text") return part;
        if (part.type === "resource_link") return { ...part, uri: await resources.address(part.uri) };
        if (resources.publish === undefined) throw new Error("MCP content requires a resource publisher.");
        const name = part.type === "resource" ? ResourceContent.name(part.resource) : undefined;
        const channel = part.type === "resource" ? ResourceContent.channel(part.resource)
            : { content: "", bytes: Buffer.from(part.data, "base64"), mimetype: part.mimeType };
        const uri = await resources.publish(channel, name);
        return {
            type: "resource_link",
            uri,
            name: name ?? decodeURIComponent(new URL(uri).pathname.split("/").at(-1)!),
            mimeType: channel.mimetype,
            ...(part.annotations === undefined ? {} : { annotations: part.annotations }),
            ...(part._meta === undefined ? {} : { _meta: part._meta }),
        };
    }
}
