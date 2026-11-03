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
const expected = ['diary_create', 'diary_list', 'diary_read', 'diary_update', 'diary_delete', 'diary_search', 'diary_claim', 'diary_template_list', 'diary_template_read', 'diary_template_set', 'diary_template_delete']
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

// ── family auth: pending bucket, read scoping, and the claim file move ──
// The service is provided after the tools were registered, exactly like a
// profile whose plugin layer loads dsh-family-auth later: the deferred
// ctx.inject must pick it up and every tool must switch to scoped storage.
const ownerActor = { id: 'u_owner', name: '户主', role: 'owner' }
const memberActor = { id: 'u_member', name: '小乙', role: 'member' }
const execFor = sessionId => ({ signal: new AbortController().signal, agent: { session: { id: sessionId } } })
const execOwner = execFor('sess-owner')
const execMember = execFor('sess-member')
const execAnonymous = { signal: new AbortController().signal }
const fakeAuth = {
  defineModule() {},
  actorOf(exec) {
    const id = exec?.agent?.session?.id
    if (id === 'sess-owner') return ownerActor
    if (id === 'sess-member') return memberActor
    return null
  },
  mustWrite(exec) {
    const actor = fakeAuth.actorOf(exec)
    return actor ? { ownerId: actor.id, anonymous: false } : { ownerId: 'default', anonymous: true }
  },
  // Mirrors dsh-family-auth: unrestricted for the owner, own + shared for a
  // member, shared-only for a conversation with no binding.
  readScope(exec) {
    const actor = fakeAuth.actorOf(exec)
    if (!actor) return new Set(['default'])
    if (actor.role === 'owner') return null
    return new Set([actor.id, 'default'])
  },
  ownerLabel(id) {
    if (id === 'default') return '未识别'
    return id === ownerActor.id ? ownerActor.name : id === memberActor.id ? memberActor.name : id
  },
  findMember(name) {
    if (name === ownerActor.name) return { id: ownerActor.id, name: ownerActor.name }
    if (name === memberActor.name) return { id: memberActor.id, name: memberActor.name }
    return null
  },
  mustAccess() {},
  record() {},
}
ctx.provide('familyAuth', fakeAuth)
await new Promise(resolve => setTimeout(resolve, 0))

const pendingCreated = await byName.diary_create.execute(
  { date: '2026-08-20', title: '待认领', content: '没人认领的时候写的一篇。' },
  execAnonymous,
)
if (!pendingCreated.path.includes('_pending')) throw new Error('anonymous write did not land in the pending bucket: ' + pendingCreated.path)
if (pendingCreated.owner !== '未识别') throw new Error('unexpected pending owner label: ' + pendingCreated.owner)
console.log('auth create (anonymous) →', pendingCreated.path)

const ownerSawPending = await byName.diary_list.execute({}, execOwner)
const ownerPendingRow = ownerSawPending.entries.find(entry => entry.date === '2026-08-20')
if (ownerPendingRow === undefined) throw new Error('the household owner cannot see the pending entry')
if (ownerPendingRow.owner !== '未识别') throw new Error('pending row is missing its owner label')
console.log('auth list (owner) → pending entry visible as', ownerPendingRow.owner)

const memberListBefore = await byName.diary_list.execute({}, execMember)
if (memberListBefore.entries.some(entry => entry.date === '2026-08-20')) throw new Error('a member can see the pending entry')
let memberBlocked = false
try {
  await byName.diary_read.execute({ date: '2026-08-20' }, execMember)
} catch {
  memberBlocked = true
}
if (!memberBlocked) throw new Error('a member could read the pending entry')
console.log('auth read (member) → pending entry refused as expected')

let memberClaimBlocked = false
try {
  await byName.diary_claim.execute({ member: memberActor.name }, execMember)
} catch {
  memberClaimBlocked = true
}
if (!memberClaimBlocked) throw new Error('a member could claim entries')

const dryRun = await byName.diary_claim.execute({ member: memberActor.name, date: '2026-08-20', dry_run: true }, execOwner)
if (dryRun.entries.length !== 1) throw new Error('dry_run did not preview the pending entry')
const stillPending = await byName.diary_list.execute({}, execOwner)
if (stillPending.entries.every(entry => entry.date !== '2026-08-20')) throw new Error('dry_run moved the entry')
console.log('auth claim dry_run → previewed', dryRun.entries.length, 'entry')

const claimed = await byName.diary_claim.execute({ member: memberActor.name, date: '2026-08-20' }, execOwner)
if (claimed.claimed !== 1) throw new Error('claim did not move the pending entry')
const claimedPath = claimed.entries[0].to
if (!claimedPath.includes('/u_member/')) throw new Error('claim did not move the file into the member directory: ' + claimedPath)
if (claimed.entries[0].from.includes('/u_member/')) throw new Error('claim moved the file from the wrong place')
console.log('auth claim →', claimed.entries[0].from, '→', claimedPath)

const memberReadAfterClaim = await byName.diary_read.execute({ date: '2026-08-20' }, execMember)
if (memberReadAfterClaim.content !== '没人认领的时候写的一篇。') throw new Error('member cannot read the claimed entry')
if (memberReadAfterClaim.owner !== memberActor.name) throw new Error('claimed entry is labelled with the wrong owner: ' + memberReadAfterClaim.owner)
console.log('auth read (member, after claim) →', memberReadAfterClaim.owner)

const memberListAfter = await byName.diary_list.execute({}, execMember)
const memberRow = memberListAfter.entries.find(entry => entry.date === '2026-08-20')
if (memberRow === undefined || memberRow.owner !== memberActor.name) throw new Error('member list does not show the claimed entry under their name')
// The single-user entries from before the auth service loaded stay in the
// legacy root bucket, which a member must never see.
if (memberListAfter.entries.some(entry => entry.date === '2026-08-14')) throw new Error('a member can read the legacy root entries')
console.log('auth list (member) →', memberListAfter.total, 'entries, legacy root hidden')

const panelRows = await runtime.listEntries()
if (!panelRows.every(row => typeof row.owner === 'string' && typeof row.ownerName === 'string')) {
  throw new Error('panel rows are missing the owner label')
}
console.log('auth panel listEntries →', panelRows.length, 'rows labelled')

await rm(root, { recursive: true, force: true })
console.log('\nALL SMOKE TESTS PASSED')
