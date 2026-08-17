import { setTimeout as wait } from "node:timers/promises";
import { request } from "./http.js";

const retryDelays = [0, 100, 200];

export async function deliver(target, event, correlationId) {
  let error;
  for (const delay of retryDelays) {
    if (delay) await wait(delay);
    try {
      return await request(target, { method: "POST", body: JSON.stringify(event) }, correlationId);
    } catch (caught) {
      error = caught;
    }
  }
  console.error(JSON.stringify({ type: "event-delivery-failed", service: process.env.SERVICE_NAME, target, event_id: event.eventId, correlation_id: correlationId, attempts: retryDelays.length, message: error.message }));
}
