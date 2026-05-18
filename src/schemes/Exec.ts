import type { SchemeManifest } from "../core/scheme-types.ts";

// PROVISIONAL: subprocess execution scheme. Streams stdout/stderr as channels
// on the entry. Dynamic mimetype per call (text/plain in the simple case;
// future per-command detection).

export default class Exec {
    static manifest: SchemeManifest = {
        name: "exec",
        channels: {},
        defaultChannel: "stdout",
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
    };
}
