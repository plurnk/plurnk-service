import { resolve } from "node:path";

// The committed gate profile is configuration and stays the checkout's; the service is the pinned runtime's.
export const candidateDaemonArgs = (root, runtime) => [
    `--env-file=${resolve(root, "plurnk-core", ".env.test")}`,
    resolve(runtime, "plurnk-core", "dist", "service.js"),
    "start",
];
