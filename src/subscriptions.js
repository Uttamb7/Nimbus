import { GraphQLError, getOperationAST, parse, validate } from "graphql";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import { authenticate } from "./auth.js";
import { inspectQuery, RateLimiter } from "./graphql-guard.js";
import { schema } from "./schema.js";

export function attachSubscriptions(server, { topology, operations, authTokens, rateLimiter = new RateLimiter() }) {
  const sockets = new WebSocketServer({ server, path: "/graphql/ws", maxPayload: 16_384, perMessageDeflate: false, verifyClient: () => sockets.clients.size < 64 });
  const cleanup = useServer({
    schema,
    connectionInitWaitTimeout: 5_000,
    onConnect(context) {
      if (!rateLimiter.allow(context.extra.request.socket.remoteAddress || "unknown")) return false;
      const authorization = context.connectionParams?.authorization;
      context.extra.identity = typeof authorization === "string" && authenticate(authorization, authTokens);
      return Boolean(context.extra.identity);
    },
    onSubscribe(context, id, payload) {
      try {
        if (Object.keys(context.subscriptions).length > 8) throw new Error("subscription limit exceeded");
        if (!rateLimiter.allow(context.extra.request.socket.remoteAddress || "unknown")) throw new Error("rate limit exceeded");
        if (typeof payload.query !== "string" || payload.query.length > 10_000) throw new Error("invalid query");
        inspectQuery(payload.query);
        const document = parse(payload.query);
        if (getOperationAST(document, payload.operationName)?.operation !== "subscription") throw new Error("use HTTP for queries and mutations");
        const errors = validate(schema, document);
        if (errors.length) return errors;
        return { schema, document, operationName: payload.operationName, variableValues: payload.variables };
      } catch (error) {
        return [new GraphQLError(error.message)];
      }
    },
    context: (context) => ({
      identity: context.extra.identity, topology, operations, events: operations.history.events,
      onOverflow: () => context.extra.socket.terminate(),
    }),
    onNext(context) {
      if (context.extra.socket.bufferedAmount > 65_536) context.extra.socket.terminate();
    },
  }, sockets);
  server.once("close", () => { void cleanup.dispose(); });
  return sockets;
}
