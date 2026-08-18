import { Kind, parse } from "graphql";

export function inspectQuery(source, { maxDepth = 8, maxComplexity = 200 } = {}) {
  const document = parse(source);
  const fragments = new Map(document.definitions.filter((node) => node.kind === Kind.FRAGMENT_DEFINITION).map((node) => [node.name.value, node]));
  let depth = 0, complexity = 0;
  const walk = (selections, level, visiting = new Set()) => {
    if (!selections?.length) return;
    depth = Math.max(depth, level);
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        complexity++;
        walk(selection.selectionSet?.selections, level + 1, visiting);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet.selections, level, visiting);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD && !visiting.has(selection.name.value)) {
        const fragment = fragments.get(selection.name.value);
        if (fragment) walk(fragment.selectionSet.selections, level, new Set([...visiting, selection.name.value]));
      }
    }
  };
  for (const definition of document.definitions.filter((node) => node.kind === Kind.OPERATION_DEFINITION)) walk(definition.selectionSet.selections, 1);
  if (depth > maxDepth) throw new Error(`query depth exceeds ${maxDepth}`);
  if (complexity > maxComplexity) throw new Error(`query complexity exceeds ${maxComplexity}`);
  return { depth, complexity };
}

export class RateLimiter {
  #requests = new Map();
  constructor(limit = 120, windowMs = 60_000, now = () => Date.now()) { Object.assign(this, { limit, windowMs, now }); }
  allow(key) {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.#requests.get(key) || []).filter((time) => time > cutoff);
    recent.push(this.now());
    this.#requests.set(key, recent);
    return recent.length <= this.limit;
  }
}
