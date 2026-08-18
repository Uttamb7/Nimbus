const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const faultStatus = Number(process.env.FAULT_STATUS || 0);
if (faultStatus && (!Number.isInteger(faultStatus) || faultStatus < 500 || faultStatus > 599)) throw new Error("FAULT_STATUS must be 500-599");

export const config = {
  name: required("SERVICE_NAME"),
  port: Number(process.env.PORT || 8080),
  identityUrl: process.env.IDENTITY_URL,
  orderUrl: process.env.ORDER_URL,
  inventoryUrl: process.env.INVENTORY_URL,
  eventTargets: process.env.EVENT_TARGETS?.split(",").filter(Boolean) || [],
  telemetryUrl: process.env.TELEMETRY_URL,
  faultStatus,
  demoMode: process.env.DEMO_MODE === "true",
  adminToken: process.env.ADMIN_TOKEN,
  authTokens: process.env.AUTH_TOKENS,
};
