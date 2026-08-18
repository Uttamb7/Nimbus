import { timingSafeEqual } from "node:crypto";

const levels = { viewer: 0, operator: 1, admin: 2 };
const safeEqual = (left, right) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function authenticate(header, configuredTokens = "") {
  const supplied = /^Bearer (\S+)$/.exec(header || "")?.[1];
  if (!supplied) return null;
  for (const entry of configuredTokens.split(",").filter(Boolean)) {
    const [token, role, actor = role] = entry.split(":");
    if (levels[role] === undefined) continue;
    if (safeEqual(supplied, token)) return { role, actor };
  }
  return null;
}

export function requireRole(identity, minimum) {
  if (!identity || levels[identity.role] < levels[minimum]) throw new Error(`${minimum} role required`);
}
