import { config } from "./config.js";

const module = config.name === "control-plane" ? await import("./control-plane.js") : await import("./server.js");
module.start().then(() => console.log(`${config.name} listening on ${config.port}`));
