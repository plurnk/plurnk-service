import { resolve } from "node:path";
import { gateProfile } from "./environment.mjs";

// The committed gate profile is configuration and stays the checkout's; the service is the pinned runtime's.
export const candidateDaemonArgs = (root, runtime) => [
    `--env-file=${gateProfile(root)}`,
    resolve(runtime, "plurnk-core", "dist", "service.js"),
    "start",
];
