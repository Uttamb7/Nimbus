export function closeOnSignals(server, signalTarget = process) {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close();
  };
  const detach = () => {
    signalTarget.off("SIGINT", close);
    signalTarget.off("SIGTERM", close);
  };
  signalTarget.once("SIGINT", close);
  signalTarget.once("SIGTERM", close);
  server.once("close", detach);
}
