// Seeds the Notion knowledge base with the demo community's starting FAQ.
//   npm run seed:kb
// Idempotent: entries are matched by question; existing ones are left alone.
import { openDb } from '../src/store/db.js'
import { prepareRuntimeDir } from '../src/swy/runtime-dir.js'
import { createPage, queryAll } from '../src/kb/notion.js'
import { SEED } from '../src/kb/seed-data.js'

prepareRuntimeDir()
openDb()

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const existing = new Set((await queryAll()).map((e) => norm(e.question)))
let created = 0
for (const s of SEED) {
  if (existing.has(norm(s.question))) continue
  await createPage({ question: s.question, answer: s.answer, source: 'Seed', learnedFrom: 'Participant guide / verified Swytchcode notes' })
  created++
  process.stdout.write('.')
}
console.log(`\n${created} created, ${SEED.length - created} already present`)
