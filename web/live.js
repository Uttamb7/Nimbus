export const retryDelay = (attempt, random = Math.random) => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.8 + random() * 0.2);

export function connectLive({ createClient, url, authorization, refresh, onState }) {
  const ready = new Set();
  let stopped = false, polling, refreshTimer, retryTimer, retryResolve, pongTimer;
  let updating = false, dirty = false, status = "CONNECTING · POLLING";
  const show = (value) => { status = value; onState(value); };
  const poll = () => { polling ??= setInterval(requestRefresh, 3_000); };
  function requestRefresh() {
    if (stopped) return;
    if (updating) { dirty = true; return; }
    refreshTimer ??= setTimeout(update, 1_000);
  }
  async function update() {
    refreshTimer = undefined;
    if (stopped) return;
    updating = true;
    try {
      await refresh();
      if (!stopped && ready.size === 3) {
        clearInterval(polling); polling = undefined;
        show("LIVE");
      } else if (!stopped) onState(status);
    } catch {
      if (!stopped) { poll(); onState("DATA UNAVAILABLE · RETRYING"); }
    } finally {
      updating = false;
      if (dirty) { dirty = false; requestRefresh(); }
    }
  }
  function disconnected() {
    if (stopped) return;
    ready.clear();
    clearTimeout(pongTimer);
    poll();
    show("RECONNECTING · POLLING");
  }
  const client = createClient({
    url, connectionParams: { authorization }, connectionAckWaitTimeout: 5_000,
    retryAttempts: Infinity, keepAlive: 10_000,
    shouldRetry: (error) => error?.code !== 4403,
    retryWait: (attempt) => new Promise((resolve) => { retryResolve = resolve; retryTimer = setTimeout(resolve, retryDelay(attempt)); }),
    on: {
      closed: disconnected,
      ping(received) { if (!received) pongTimer = setTimeout(() => client.terminate(), 5_000); },
      pong(received) { if (received) clearTimeout(pongTimer); },
    },
  });
  const stopSubscriptions = ["serviceHealthChanged", "incidentChanged", "auditEventAdded"].map((field) => client.subscribe({ query: `subscription { ${field} { ${field === "serviceHealthChanged" ? "name" : "id"} } }` }, {
    next(result) {
      if (stopped) return;
      if (result.errors) { unavailable(); return; }
      ready.add(field);
      // The server's initial null confirms registration, not just socket auth.
      if (ready.size === 3 || result.data?.[field]) requestRefresh();
    },
    error: unavailable,
    complete: unavailable,
  }));
  function unavailable() {
    if (stopped) return;
    ready.clear();
    poll();
    show("SUBSCRIPTIONS UNAVAILABLE · POLLING");
  }
  poll();
  show(status);
  void update();
  return {
    refresh: requestRefresh,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(polling);
      for (const timer of [refreshTimer, retryTimer, pongTimer]) clearTimeout(timer);
      retryResolve?.();
      for (const stop of stopSubscriptions) stop();
      void client.dispose();
    },
  };
}
