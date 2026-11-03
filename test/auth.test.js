// Authorization tests for the dsh-diary auth seam.
//
// They drive the built tools with a fake `familyAuth` service (actorOf /
// mustWrite / readScope / ownerLabel / findMember / mustAccess), so the
// per-member layout, the pending bucket, the claim file move, and the refusal
// when `identity: 'auth'` is configured without the service are covered without
// booting a harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'

const OWNER = { id: 'u_owner', name: '户主', role: 'owner' }
const MEMBER_A = { id: 'u_a', name: '小甲', role: 'member' }
const MEMBER_B = { id: 'u_b', name: '小乙', role: 'member' }

/** The tool execution shape dsh-family-auth reads a session id from. */
function execFor(sessionId) {
  return { signal: new AbortController().signal, agent: { session: { id: sessionId } } }
}
const EXEC_OWNER = execFor('sess-owner')
const EXEC_A = execFor('sess-a')
const EXEC_B = execFor('sess-b')
const EXEC_ANONYMOUS = { signal: new AbortController().signal }

/** A stand-in for dsh-family-auth's service, with the real policy's shape. */
function createFakeAuth() {
  const auth = {
    defineModule() {},
    actorOf(exec) {
      const id = exec?.agent?.session?.id
      if (id === 'sess-owner') return OWNER
      if (id === 'sess-a') return MEMBER_A
      if (id === 'sess-b') return MEMBER_B
      return null
    },
    mustWrite(exec) {
      const actor = auth.actorOf(exec)
      return actor ? { ownerId: actor.id, anonymous: false } : { ownerId: 'default', anonymous: true }
    },
    readScope(exec) {
      const actor = auth.actorOf(exec)
      if (!actor) return new Set(['default'])
      if (actor.role === 'owner') return null
      return new Set([actor.id, 'default'])
    },
    ownerLabel(id) {
      if (id === 'default' || id === '') return '未识别'
      if (id === OWNER.id) return OWNER.name
      if (id === MEMBER_A.id) return MEMBER_A.name
      if (id === MEMBER_B.id) return MEMBER_B.name
      return id
    },
    findMember(name) {
      for (const actor of [OWNER, MEMBER_A, MEMBER_B]) {
        if (actor.name === name) return { id: actor.id, name: actor.name, role: actor.role }
      }
      return null
    },
    mustAccess(exec, module, action, resource) {
      const actor = auth.actorOf(exec)
      if (!actor) throw new Error('NO_SESSION: this execution has no member')
      if (actor.role === 'owner') return { actor, reason: 'owner' }
      if (resource?.ownerId === actor.id) return { actor, reason: 'self' }
      throw new Error('DENIED: member ' + actor.name + ' may not ' + action + ' this ' + module + ' record')
    },
    record() {},
  }
  return auth
}

/**
 * Mount the plugin against a throwaway directory and hand the tools to `run`.
 * `withAuth: false` leaves the optional service unprovided, which is what a
 * profile that configured `identity: 'auth'` but never loaded the plugin hit.
 */
async function withHarness({ withAuth = true, config = {} } = {}, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diary-auth-'))
  const registered = []
  const ctx = new Context()
  ctx.provide('tools', { register(def) { registered.push(def) } })
  ctx.provide('typert', { register() { return () => {} } })
  apply(ctx, { directory: dir, identity: 'auth', ...config })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  if (withAuth) {
    // Provide the service after the tools are registered: the deferred
    // ctx.inject must pick it up, exactly like a profile that loads the auth
    // plugin later.
    ctx.provide('familyAuth', createFakeAuth())
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  try {
    await run({ dir, ctx, registered, byName })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('member A cannot list or read member B\'s entry', async () => {
  await withHarness({}, async ({ byName }) => {
    const created = await byName.diary_create.execute({ date: '2026-09-01', title: '小乙的一天', content: 'B 的私密内容' }, EXEC_B)
    assert.match(created.path, /\/u_b\/2026-09-01\.md$/)
    assert.equal(created.owner, MEMBER_B.name)

    const listA = await byName.diary_list.execute({}, EXEC_A)
    assert.equal(listA.total, 0, 'member A must not see member B\'s entry')

    await assert.rejects(() => byName.diary_read.execute({ date: '2026-09-01' }, EXEC_A), /not found/)
    await assert.rejects(() => byName.diary_update.execute({ date: '2026-09-01', content: '篡改' }, EXEC_A), /not found/)
    await assert.rejects(() => byName.diary_delete.execute({ date: '2026-09-01' }, EXEC_A), /not found/)

    const searchA = await byName.diary_search.execute({ query: '私密' }, EXEC_A)
    assert.equal(searchA.total, 0)

    const readB = await byName.diary_read.execute({ date: '2026-09-01' }, EXEC_B)
    assert.equal(readB.content, 'B 的私密内容')
    assert.equal(readB.owner, MEMBER_B.name)

    const listB = await byName.diary_list.execute({}, EXEC_B)
    assert.equal(listB.total, 1)
    assert.equal(listB.entries[0].owner, MEMBER_B.name)

    const searchB = await byName.diary_search.execute({ query: '私密' }, EXEC_B)
    assert.equal(searchB.total, 1)
    assert.equal(searchB.matches[0].owner, MEMBER_B.name)
  })
})

test('a shared date is never merged silently', async () => {
  await withHarness({}, async ({ byName }) => {
    await byName.diary_create.execute({ date: '2026-09-02', content: '甲的内容' }, EXEC_A)
    await byName.diary_create.execute({ date: '2026-09-02', content: '乙的内容' }, EXEC_B)

    // Each member sees exactly their own entry for that date.
    assert.equal((await byName.diary_read.execute({ date: '2026-09-02' }, EXEC_A)).content, '甲的内容')
    assert.equal((await byName.diary_read.execute({ date: '2026-09-02' }, EXEC_B)).content, '乙的内容')

    // The household owner sees both and must say whose entry they mean.
    await assert.rejects(() => byName.diary_read.execute({ date: '2026-09-02' }, EXEC_OWNER), /owner/)
    const list = await byName.diary_list.execute({}, EXEC_OWNER)
    assert.equal(list.total, 2)
    assert.deepEqual(
      list.entries.map(entry => entry.owner).sort(),
      [MEMBER_A.name, MEMBER_B.name].sort(),
    )

    const picked = await byName.diary_read.execute({ date: '2026-09-02', owner: MEMBER_B.name }, EXEC_OWNER)
    assert.equal(picked.content, '乙的内容')
  })
})

test('an anonymous write lands in the pending bucket; the owner sees it, a member does not', async () => {
  await withHarness({}, async ({ dir, byName }) => {
    const created = await byName.diary_create.execute({ date: '2026-09-03', content: '没人认领的时候写的' }, EXEC_ANONYMOUS)
    assert.equal(created.pending, true)
    assert.equal(created.owner, '未识别')
    assert.match(created.path, /\/_pending\/2026-09-03\.md$/)
    assert.deepEqual(await readdir(join(dir, '_pending')), ['2026-09-03.md'])
    assert.deepEqual(await readdir(join(dir, 'u_a')).catch(() => []), [])

    const ownerList = await byName.diary_list.execute({}, EXEC_OWNER)
    const ownerRow = ownerList.entries.find(entry => entry.date === '2026-09-03')
    assert.ok(ownerRow, 'the household owner must see the pending entry')
    assert.equal(ownerRow.owner, '未识别')
    assert.equal((await byName.diary_read.execute({ date: '2026-09-03' }, EXEC_OWNER)).content, '没人认领的时候写的')

    const memberList = await byName.diary_list.execute({}, EXEC_A)
    assert.equal(memberList.total, 0, 'a member must not see the pending bucket')
    await assert.rejects(() => byName.diary_read.execute({ date: '2026-09-03' }, EXEC_A), /not found/)
    const memberSearch = await byName.diary_search.execute({ query: '没人认领' }, EXEC_A)
    assert.equal(memberSearch.total, 0)
  })
})

test('diary_claim moves the pending entry and afterwards member B can read it', async () => {
  await withHarness({}, async ({ dir, byName }) => {
    await byName.diary_create.execute({ date: '2026-09-04', content: '第一篇待认领' }, EXEC_ANONYMOUS)
    await byName.diary_create.execute({ date: '2026-09-05', content: '第二篇待认领' }, EXEC_ANONYMOUS)

    // Only the household owner may claim.
    await assert.rejects(() => byName.diary_claim.execute({ member: MEMBER_B.name }, EXEC_B), /户主/)
    await assert.rejects(() => byName.diary_claim.execute({ member: '不存在的人' }, EXEC_OWNER), /成员表/)

    // A dry run previews without touching the files.
    const preview = await byName.diary_claim.execute({ member: MEMBER_B.name, date: '2026-09-04', dry_run: true }, EXEC_OWNER)
    assert.equal(preview.dryRun, true)
    assert.equal(preview.claimed, 0)
    assert.equal(preview.entries.length, 1)
    assert.deepEqual(await readdir(join(dir, '_pending')), ['2026-09-04.md', '2026-09-05.md'])

    const claimed = await byName.diary_claim.execute({ member: MEMBER_B.name, date: '2026-09-04' }, EXEC_OWNER)
    assert.equal(claimed.claimed, 1)
    assert.match(claimed.entries[0].from, /\/_pending\/2026-09-04\.md$/)
    assert.match(claimed.entries[0].to, /\/u_b\/2026-09-04\.md$/)

    // Claim everything else with no date.
    const claimedRest = await byName.diary_claim.execute({ member: MEMBER_B.name }, EXEC_OWNER)
    assert.equal(claimedRest.claimed, 1)
    assert.deepEqual(await readdir(join(dir, '_pending')), [])
    assert.deepEqual((await readdir(join(dir, 'u_b'))).sort(), ['2026-09-04.md', '2026-09-05.md'])

    // B can read it now; A still cannot.
    const readB = await byName.diary_read.execute({ date: '2026-09-04' }, EXEC_B)
    assert.equal(readB.content, '第一篇待认领')
    assert.equal(readB.owner, MEMBER_B.name)
    await assert.rejects(() => byName.diary_read.execute({ date: '2026-09-04' }, EXEC_A), /not found/)
    const listA = await byName.diary_list.execute({}, EXEC_A)
    assert.equal(listA.total, 0)

    // Claiming again finds nothing rather than duplicating anything.
    const again = await byName.diary_claim.execute({ member: MEMBER_B.name }, EXEC_OWNER)
    assert.equal(again.claimed, 0)
  })
})

test("identity: 'auth' without the service refuses every tool", async () => {
  // Argument shapes only matter because the tool wrapper validates them before
  // execute(); the refusal itself must not depend on the arguments.
  const validArgs = {
    diary_create: { content: 'x' },
    diary_list: {},
    diary_read: { date: '2026-09-06' },
    diary_update: { date: '2026-09-06', content: 'x' },
    diary_delete: { date: '2026-09-06' },
    diary_search: { query: 'x' },
    diary_claim: { member: MEMBER_B.name },
    diary_template_list: {},
    diary_template_read: { name: 'daily' },
    diary_template_set: { name: 'daily', content: 'x' },
    diary_template_delete: { name: 'daily' },
  }
  await withHarness({ withAuth: false }, async ({ registered }) => {
    assert.equal(registered.length, 11, 'every diary tool must be registered')
    for (const tool of registered) {
      assert.ok(validArgs[tool.name] !== undefined, 'test has no sample arguments for ' + tool.name)
      await assert.rejects(
        () => tool.execute(validArgs[tool.name], EXEC_OWNER),
        error => {
          assert.match(error.message, /dsh-family-auth/, tool.name + ' must name the missing plugin')
          assert.match(error.message, /single/, tool.name + ' must mention the single-mode fallback')
          return true
        },
      )
    }
  })
})

test("'single' identity keeps the historical root layout without the service", async () => {
  await withHarness({ withAuth: false, config: { identity: 'single' } }, async ({ dir, byName }) => {
    const created = await byName.diary_create.execute({ date: '2026-09-07', content: '单人模式' }, EXEC_ANONYMOUS)
    assert.equal(created.path, join(dir, '2026-09-07.md'))
    assert.equal(created.owner, '')
    assert.equal(created.pending, false)
    const read = await byName.diary_read.execute({ date: '2026-09-07' }, EXEC_ANONYMOUS)
    assert.equal(read.content, '单人模式')
  })
})

test('the web panel labels each entry with its owner and can be turned off', async () => {
  await withHarness({}, async ({ ctx, byName }) => {
    await byName.diary_create.execute({ date: '2026-09-08', content: '甲的看板条目' }, EXEC_A)
    await byName.diary_create.execute({ date: '2026-09-09', content: '待认领的看板条目' }, EXEC_ANONYMOUS)

    const runtime = ctx.reflect.get('diary')
    assert.ok(runtime, 'the diary Remote service must be registered')
    const rows = await runtime.listEntries()
    const owners = new Map(rows.map(row => [row.date, row.ownerName]))
    assert.equal(owners.get('2026-09-08'), MEMBER_A.name)
    assert.equal(owners.get('2026-09-09'), '未识别')

    // Entry identity in the panel includes the owner, so get/delete are unambiguous.
    const read = await runtime.getEntry('2026-09-08', '', MEMBER_A.id)
    assert.equal(read.content, '甲的看板条目')
    const deleted = await runtime.deleteEntry('2026-09-08', '', MEMBER_A.id)
    assert.equal(deleted.deleted, true)
  })

  await withHarness({ config: { panel: 'off' } }, async ({ ctx }) => {
    const runtime = ctx.reflect.get('diary')
    await assert.rejects(() => runtime.listEntries(), /panel/)
    await assert.rejects(() => runtime.getEntry('2026-09-08', '', undefined), /panel/)
  })
})
