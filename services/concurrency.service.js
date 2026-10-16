class QueueFullError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 429;
  }
}

class ConcurrencyLimiter {
  constructor(limit, maxQueue = limit * 10) {
    this.limit = Math.max(1, limit);
    this.maxQueue = Math.max(0, maxQueue);
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    if (this.active < this.limit) {
      this.active += 1;
      return this.execute(task);
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError('El servicio está ocupado. Intenta nuevamente en unos segundos.'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
    });
  }

  async execute(task) {
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) {
        this.active += 1;
        this.execute(next.task).then(next.resolve, next.reject);
      }
    }
  }
}

class KeyedMutex {
  constructor() {
    this.locks = new Map();
  }

  async run(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(key, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

module.exports = { ConcurrencyLimiter, KeyedMutex };
