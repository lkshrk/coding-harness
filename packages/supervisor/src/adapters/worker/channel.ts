type Waiter<T> = { resolve(r: IteratorResult<T>): void; reject(e: Error): void }

export class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: Waiter<T> | undefined
  private failure: Error | undefined
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiter
    this.waiter = undefined
    if (waiter) waiter.resolve({ value: item, done: false })
    else this.items.push(item)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    const waiter = this.waiter
    this.waiter = undefined
    if (!waiter) return
    if (error) waiter.reject(error)
    else waiter.resolve({ value: undefined, done: true })
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false })
    if (this.closed) {
      return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true })
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }
}
