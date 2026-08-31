// Live notifications only: each subscriber has a bounded, disposable queue.
export class LiveEvents {
  #subscribers = new Set();

  get size() { return this.#subscribers.size; }

  subscribe(topic, onOverflow = () => {}) {
    const queue = [{ [topic]: null }]; // Confirms this operation is listening.
    let waiting, done = false;
    const finish = () => {
      done = true;
      queue.length = 0;
      this.#subscribers.delete(subscriber);
      waiting?.({ done: true });
      waiting = undefined;
      return Promise.resolve({ done: true });
    };
    const subscriber = { topic, push(value) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ value: { [topic]: value }, done: false });
      } else if (queue.length < 32) {
        queue.push({ [topic]: value });
      } else {
        finish();
        queueMicrotask(onOverflow);
      }
    } };
    this.#subscribers.add(subscriber);
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (done) return Promise.resolve({ done: true });
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        return new Promise((resolve) => { waiting = resolve; });
      },
      return: finish,
    };
  }

  publish(topic, value) {
    for (const subscriber of this.#subscribers) {
      if (subscriber.topic === topic) subscriber.push(value);
    }
  }
}
