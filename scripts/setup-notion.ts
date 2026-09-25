// Shapes the connected Notion database into Pulse's knowledge base.
//   npm run setup:notion
// Idempotent: renames the title column to "Question" and adds missing columns.
import { openDb } from '../src/store/db.js'
import { kvSet } from '../src/store/repo.js'
import { swyExec } from '../src/swy/exec.js'
import { prepareRuntimeDir } from '../src/swy/runtime-dir.js'
import { dataSourceId, KB_PROPERTIES, N } from '../src/kb/notion.js'

prepareRuntimeDir()
openDb()
kvSet('notion.dataSourceId', '') // re-resolve
kvSet('notion.titleProp', '')

const ds = await dataSourceId()
console.log(`data source ${ds}`)

const current = await swyExec<{ properties?: Record<string, { type: string }> }>(N.dsGet, { params: { data_source_id: ds } })
const props = current.data.properties ?? {}
const title = Object.entries(props).find(([, v]) => v.type === 'title')?.[0]
console.log(`existing columns: ${Object.entries(props).map(([k, v]) => `${k}:${v.type}`).join(', ')}`)

const update: Record<string, unknown> = { ...KB_PROPERTIES }
if (title && title !== 'Question') update[title] = { name: 'Question' }
// Drop default columns Notion adds to new databases that Pulse doesn't use.
for (const [name, v] of Object.entries(props)) {
  if (name in KB_PROPERTIES || v.type === 'title') continue
  if (['Tags', 'Date', 'Status 1'].includes(name)) update[name] = null
}

await swyExec(N.dsUpdate, {
  params: { data_source_id: ds },
  body: { title: [{ type: 'text', text: { content: 'Pulse · Community Knowledge' } }], properties: update },
})
kvSet('notion.titleProp', 'Question')

const after = await swyExec<{ properties?: Record<string, { type: string }> }>(N.dsGet, { params: { data_source_id: ds } })
console.log(`columns now: ${Object.entries(after.data.properties ?? {}).map(([k, v]) => `${k}:${v.type}`).join(', ')}`)
