const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const config = {
  name: required("SERVICE_NAME"),
  port: Number(process.env.PORT || 8080),
  identityUrl: process.env.IDENTITY_URL,
  orderUrl: process.env.ORDER_URL,
  inventoryUrl: process.env.INVENTORY_URL,
  eventTargets: process.env.EVENT_TARGETS?.split(",").filter(Boolean) || [],
  telemetryUrl: process.env.TELEMETRY_URL,
};
