// Async readers/writer lock. Every swy exec holds a read lock; rewriting
// policies.json takes the write lock, so the Go binary never has the file open
// while we swap it (Windows refuses to rename over an open handle).
// Writers get priority: once a writer is waiting, new readers queue behind it.

type Waiter = () => void

export class RWLock {
  private readers = 0
  private writing = false
  private readQueue: Waiter[] = []
  private writeQueue: Waiter[] = []

  async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead()
    try {
      return await fn()
    } finally {
      this.releaseRead()
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite()
    try {
      return await fn()
    } finally {
      this.releaseWrite()
    }
  }

  get state(): { readers: number; writing: boolean; waitingWriters: number; waitingReaders: number } {
    return {
      readers: this.readers,
      writing: this.writing,
      waitingWriters: this.writeQueue.length,
      waitingReaders: this.readQueue.length,
    }
  }

  private acquireRead(): Promise<void> {
    if (!this.writing && this.writeQueue.length === 0) {
      this.readers++
      return Promise.resolve()
    }
    return new Promise((resolve) =>
      this.readQueue.push(() => {
        this.readers++
        resolve()
      }),
    )
  }

  private releaseRead(): void {
    this.readers--
    if (this.readers === 0) this.drain()
  }

  private acquireWrite(): Promise<void> {
    if (!this.writing && this.readers === 0) {
      this.writing = true
      return Promise.resolve()
    }
    return new Promise((resolve) =>
      this.writeQueue.push(() => {
        this.writing = true
        resolve()
      }),
    )
  }

  private releaseWrite(): void {
    this.writing = false
    this.drain()
  }

  private drain(): void {
    if (this.writing || this.readers > 0) return
    const writer = this.writeQueue.shift()
    if (writer) {
      writer()
      return
    }
    const readers = this.readQueue.splice(0)
    for (const r of readers) r()
  }
}

/** Counting semaphore for spawn concurrency. */
export class Semaphore {
  private active = 0
  private queue: Waiter[] = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed straight to the next waiter (no decrement),
    // so a new caller can't sneak in between and exceed `max`.
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r))
    else this.active++
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.active--
    }
  }
}

export const policyLock = new RWLock()
