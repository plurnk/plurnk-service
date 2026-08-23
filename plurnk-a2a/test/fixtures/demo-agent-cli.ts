// Runs the independent DemoAgent as a process for out-of-process harnesses
// (client test runners): prints its base URL on stdout and serves until
// SIGTERM/SIGINT.
import { startDemoAgent } from "./DemoAgent.ts";

const agent = await startDemoAgent();
process.stdout.write(`${agent.baseUrl}\n`);
const stop = async (): Promise<void> => {
    await agent.close();
    process.exit(0);
};
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
setInterval(() => {}, 1 << 30);
