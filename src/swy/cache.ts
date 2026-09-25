import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// `swy info` ≈ 2.5 s and `swy discover` ≈ 3.7 s per call, so both are cached.
// info / list are stable for a given bundle version → persisted to disk.
// discover hits the registry and can change → short in-memory TTL.

interface Entry<T> {
  value: T
  expires: number // epoch ms; Infinity = never
}

export class TtlCache<T> {
  private map = new Map<string, Entry<T>>()
  hits = 0
  misses = 0

  constructor(
    private readonly ttlMs: number,
    private readonly file?: string,
  ) {
    if (file) this.load()
  }

  get(key: string): T | undefined {
    const e = this.map.get(key)
    if (e && e.expires > Date.now()) {
      this.hits++
      return e.value
    }
    if (e) this.map.delete(key)
    this.misses++
    return undefined
  }

  set(key: string, value: T): void {
    this.map.set(key, { value, expires: this.ttlMs === Infinity ? Infinity : Date.now() + this.ttlMs })
    this.scheduleSave()
  }

  async getOrLoad(key: string, load: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.get(key)
    if (hit !== undefined) return { value: hit, cached: true }
    const value = await load()
    this.set(key, value)
    return { value, cached: false }
  }

  clear(): void {
    this.map.clear()
    this.scheduleSave()
  }

  get size(): number {
    return this.map.size
  }

  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, 1000)
    this.saveTimer.unref?.()
  }

  save(): void {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const obj: Record<string, T> = {}
      for (const [k, e] of this.map) if (e.expires === Infinity) obj[k] = e.value
      writeFileSync(this.file, JSON.stringify(obj))
    } catch {
      /* cache persistence is best-effort */
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const obj = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, T>
      for (const [k, v] of Object.entries(obj)) this.map.set(k, { value: v, expires: Infinity })
    } catch {
      /* corrupt cache file → start empty */
    }
  }
}

const cacheDir = path.join(process.cwd(), '.runtime', 'cache')

export const infoCache = new TtlCache<unknown>(Infinity, path.join(cacheDir, 'swy-info.json'))
export const listCache = new TtlCache<string[]>(Infinity, path.join(cacheDir, 'swy-list.json'))
export const discoverCache = new TtlCache<unknown>(10 * 60_000)

export function cacheStats(): { hits: number; misses: number; hitRate: number } {
  const hits = infoCache.hits + listCache.hits + discoverCache.hits
  const misses = infoCache.misses + listCache.misses + discoverCache.misses
  return { hits, misses, hitRate: hits + misses ? hits / (hits + misses) : 0 }
}

export function normalizeIntent(intent: string): string {
  return intent.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
