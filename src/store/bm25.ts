// Small Okapi BM25 over in-memory documents. Used for repeat-question search
// (node:sqlite has no FTS5) and reusable for any other lexical index.

const STOP = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or so that the this to what when where which who why will with you your'.split(' '),
)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.\s-]/g, ' ')
    .split(/[\s]+/)
    .map(t => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(t => t.length > 1 && !STOP.has(t))
}

export interface Bm25Hit<T> {
  doc: T
  score: number
}

export class Bm25Index<T> {
  private docs: Array<{ doc: T; tf: Map<string, number>; len: number }> = []
  private df = new Map<string, number>()
  private totalLen = 0

  constructor(
    private readonly textOf: (doc: T) => string,
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  add(doc: T): void {
    const tokens = tokenize(this.textOf(doc))
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    this.docs.push({ doc, tf, len: tokens.length })
    this.totalLen += tokens.length
  }

  get size(): number {
    return this.docs.length
  }

  search(query: string, limit = 5, minScore = 0): Bm25Hit<T>[] {
    const q = [...new Set(tokenize(query))]
    if (!q.length || !this.docs.length) return []
    const n = this.docs.length
    const avg = this.totalLen / n || 1
    const hits: Bm25Hit<T>[] = []
    for (const d of this.docs) {
      let score = 0
      for (const term of q) {
        const f = d.tf.get(term)
        if (!f) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg)))
      }
      if (score > minScore) hits.push({ doc: d.doc, score })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}
