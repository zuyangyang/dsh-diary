// Functional smoke test for the built plugin: loads lib/index.js, mounts it on
// a real cordis Context with mock `tools`/`typert` services, then exercises the
// full CRUD + search + template lifecycle against a throwaway directory.
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { apply, name, inject } from './lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-diary-smoke-'))
const registered = []
const ctx = new Context()
ctx.provide('tools', { register(def) { registered.push(def) } })
ctx.provide('typert', { register() { return () => {} } })

apply(ctx, { directory: root })

const names = registered.map(t => t.name)
const expected = ['diary_create', 'diary_list', 'diary_read', 'diary_update', 'diary_delete', 'diary_search', 'diary_template_list', 'diary_template_read', 'diary_template_set', 'diary_template_delete']
if (name !== 'dsh-diary') throw new Error(`bad module name: ${name}`)
if (JSON.stringify(inject) !== JSON.stringify(['tools', 'typert'])) throw new Error(`bad inject: ${JSON.stringify(inject)}`)
for (const n of expected) if (!names.includes(n)) throw new Error(`missing tool ${n}`)
console.log('module exports OK:', { name, inject, tools: names })

const byName = Object.fromEntries(registered.map(t => [t.name, t]))
const exec = { signal: new AbortController().signal }

// create
const created = await byName.diary_create.execute(
  { date: '2026-08-14', title: 'First day', content: 'Wrote my first diary entry.\nIt has two lines.', tags: ['work'] },
  exec,
)
console.log('create →', created)

// create duplicate should fail
let duplicateRejected = false
try {
  await byName.diary_create.execute({ date: '2026-08-14', content: 'dup' }, exec)
} catch {
  duplicateRejected = true
}
if (!duplicateRejected) throw new Error('duplicate create did not reject')
console.log('create duplicate → rejected as expected')

// create a second entry with a slug on the same date
const second = await byName.diary_create.execute(
  { date: '2026-08-14', slug: 'evening', content: 'Evening reflection.', tags: ['life'] },
  exec,
)
console.log('create (slug) →', second)

// list
const list = await byName.diary_list.execute({ year: 2026, month: 8 }, exec)
if (list.total !== 2) throw new Error(`expected 2 entries, got ${list.total}`)
console.log('list →', list)

// read
const read = await byName.diary_read.execute({ date: '2026-08-14' }, exec)
if (read.content !== 'Wrote my first diary entry.\nIt has two lines.') throw new Error('read content mismatch')
if (read.title !== 'First day') throw new Error('read title mismatch')
console.log('read →', { title: read.title, content: read.content })

// update: append
const updated = await byName.diary_update.execute({ date: '2026-08-14', append: 'Appended line.' }, exec)
if (!updated.content.endsWith('Appended line.')) throw new Error('append failed')
console.log('update (append) →', updated)

// search
const search = await byName.diary_search.execute({ query: 'reflection' }, exec)
if (search.total !== 1 || search.matches[0].slug !== 'evening') throw new Error('search mismatch')
console.log('search →', search)

// delete
const deleted = await byName.diary_delete.execute({ date: '2026-08-14', slug: 'evening' }, exec)
if (!deleted.deleted) throw new Error('delete failed')
console.log('delete →', deleted)

const after = await byName.diary_list.execute({}, exec)
if (after.total !== 1) throw new Error(`expected 1 entry after delete, got ${after.total}`)
console.log('final list →', after)

// ── template feature ──
const tplSet = await byName.diary_template_set.execute(
  { name: 'daily', content: '# {{title}}\n\n{{date}} · {{tags}}\n\n今天做了什么：\n- ' },
  exec,
)
console.log('template_set →', tplSet)

const tplList = await byName.diary_template_list.execute({}, exec)
if (tplList.total !== 1 || tplList.templates[0].name !== 'daily') throw new Error('template_list mismatch')
console.log('template_list →', tplList)

const tplRead = await byName.diary_template_read.execute({ name: 'daily' }, exec)
if (!tplRead.content.includes('{{date}}')) throw new Error('template_read mismatch')
console.log('template_read →', tplRead)

const fromTemplate = await byName.diary_create.execute(
  { date: '2026-08-15', title: '模板日', tags: ['tpl'], template: 'daily' },
  exec,
)
const readTpl = await byName.diary_read.execute({ date: '2026-08-15' }, exec)
if (!readTpl.content.includes('模板日')) throw new Error('template placeholder {{title}} not substituted')
if (!readTpl.content.includes('2026-08-15')) throw new Error('template placeholder {{date}} not substituted')
if (!readTpl.content.includes('tpl')) throw new Error('template placeholder {{tags}} not substituted')
console.log('create from template →', readTpl)

const fromBoth = await byName.diary_create.execute(
  { date: '2026-08-16', slug: 'both', template: 'daily', content: '追加内容' },
  exec,
)
const readBoth = await byName.diary_read.execute({ date: '2026-08-16', slug: 'both' }, exec)
if (!readBoth.content.includes('追加内容')) throw new Error('template + content append failed')
console.log('template + content append → OK')

const tplDel = await byName.diary_template_delete.execute({ name: 'daily' }, exec)
if (!tplDel.deleted) throw new Error('template_delete failed')
const tplAfter = await byName.diary_template_list.execute({}, exec)
if (tplAfter.total !== 0) throw new Error('template not deleted')
console.log('template_delete →', tplDel)

// ── remote runtime methods (board) ──
const runtime = ctx.reflect.get('diary')
if (runtime === undefined) throw new Error('diary remote service not registered')
const runtimeEntries = await runtime.listEntries()
if (!Array.isArray(runtimeEntries)) throw new Error('runtime listEntries failed')
console.log('runtime listEntries →', runtimeEntries.length, 'entries')

const runtimeCreated = await runtime.createEntry({ date: '2026-08-17', title: '看板', content: 'board entry' })
console.log('runtime createEntry →', runtimeCreated)

const runtimeGot = await runtime.getEntry('2026-08-17', '')
if (runtimeGot.content !== 'board entry' || runtimeGot.title !== '看板') throw new Error('runtime getEntry mismatch')
console.log('runtime getEntry →', { title: runtimeGot.title, content: runtimeGot.content })

const runtimeDeleted = await runtime.deleteEntry('2026-08-17', '')
if (!runtimeDeleted.deleted) throw new Error('runtime deleteEntry failed')
console.log('runtime deleteEntry → OK')

await rm(root, { recursive: true, force: true })
console.log('\nALL SMOKE TESTS PASSED')
