import { describe, expect, it } from 'vitest'
import { RWLock, Semaphore } from '../../src/swy/lock.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('RWLock', () => {
  it('lets readers run concurrently', async () => {
    const lock = new RWLock()
    let active = 0
    let peak = 0
    await Promise.all(
      [1, 2, 3].map(() =>
        lock.read(async () => {
          active++
          peak = Math.max(peak, active)
          await tick()
          active--
        }),
      ),
    )
    expect(peak).toBe(3)
  })

  it('makes a writer wait for readers and excludes everyone', async () => {
    const lock = new RWLock()
    const log: string[] = []
    const r1 = lock.read(async () => {
      log.push('r1-start')
      await tick(20)
      log.push('r1-end')
    })
    const w = lock.write(async () => {
      log.push('w-start')
      await tick(5)
      log.push('w-end')
    })
    await Promise.all([r1, w])
    expect(log).toEqual(['r1-start', 'r1-end', 'w-start', 'w-end'])
  })

  it('gives writers priority over newly arriving readers', async () => {
    const lock = new RWLock()
    const log: string[] = []
    const r1 = lock.read(async () => {
      await tick(20)
      log.push('r1')
    })
    await tick(1)
    const w = lock.write(async () => {
      log.push('w')
    })
    const r2 = lock.read(async () => {
      log.push('r2')
    })
    await Promise.all([r1, w, r2])
    expect(log).toEqual(['r1', 'w', 'r2'])
  })

  it('releases on error', async () => {
    const lock = new RWLock()
    await expect(lock.write(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(lock.state).toEqual({ readers: 0, writing: false, waitingWriters: 0, waitingReaders: 0 })
  })
})

describe('Semaphore', () => {
  it('never exceeds its limit', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(3)
          active--
        }),
      ),
    )
    expect(peak).toBe(2)
  })
})
