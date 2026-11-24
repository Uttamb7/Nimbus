import { config } from "./config.js";
import { closeOnSignals } from "./shutdown.js";
import { startTracing } from "./tracing.js";

await startTracing();
const module = config.name === "control-plane" ? await import("./control-plane.js") : await import("./server.js");
const server = await module.start();
closeOnSignals(server);
console.log(`${config.name} listening on ${config.port}`);
