/**
 * dsh-diary client plugin: the browser half of the diary settings section and
 * the standalone diary board. Mounts the `diary` Remote namespace (directory +
 * templates + entries), registers the `settings.section` slot with a template
 * manager, and mounts the board portal (month-grouped entries + "new entry").
 */
// Type-only: the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.slots / SlotMap and LocaleNamespaceMap merges.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the `settings.section` slot this plugin contributes to.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { DirectoryView, EntryCreateInput, EntryMeta, TemplateMeta } from '../contract.ts'
import { DIARY_INVOCATIONS } from '../contract.ts'
import { DiarySection, type DiarySectionInjected } from './DiarySection.tsx'
import { DiaryBoard, type DiaryBoardInjected } from './DiaryBoard.tsx'
import { NS, en, zh } from './locales.ts'
import { adoptStyles } from './styles.ts'

/** Required services: Remote face, slot system, locale dictionaries. */
export const inject = ['remote', 'slots', 'locale']

/** The `diary` Remote namespace's client contribution. */
export const DIARY_REMOTE: TypertRemoteContribution = {
  package: 'dsh-diary',
  descriptors: DIARY_INVOCATIONS,
}

/** The mounted `diary` namespace service's callable face. */
interface DiaryFace {
  getDirectory(): Promise<RemoteResult<DirectoryView>>
  listTemplates(): Promise<RemoteResult<readonly TemplateMeta[]>>
  getTemplate(name: string): Promise<RemoteResult<{ name: string; content: string }>>
  setTemplate(name: string, content: string): Promise<RemoteResult<{ name: string; sizeBytes: number }>>
  deleteTemplate(name: string): Promise<RemoteResult<{ deleted: boolean }>>
  listEntries(): Promise<RemoteResult<readonly EntryMeta[]>>
  getEntry(date: string, slug: string): Promise<RemoteResult<{ date: string; slug: string; title: string; tags: string[]; content: string }>>
  createEntry(input: EntryCreateInput): Promise<RemoteResult<{ path: string; date: string; slug: string; title: string; tags: string[] }>>
  deleteEntry(date: string, slug: string): Promise<RemoteResult<{ deleted: boolean }>>
}

/**
 * Compose the diary settings surface and the board.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-diary: dictionaries')

  // The mounted namespace handle resolves through the service store
  // (`ctx.reflect.get`), not a dotted `ctx.remote.diary` read (which walks the
  // cordis fiber chain and stops at the Loader's runtime-less internal forks).
  let diary: DiaryFace | undefined
  let resolveMount: () => void = () => {}
  const mountReady = new Promise<void>(resolve => { resolveMount = resolve })
  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(DIARY_REMOTE)
    diary = (ctx.reflect as unknown as { get(name: string): unknown }).get('remote.diary') as DiaryFace | undefined
    if (diary === undefined) {
      throw new Error('dsh-diary: the diary Remote namespace did not mount')
    }
    resolveMount()
    return () => {
      diary = undefined
      void dispose()
    }
  }, 'dsh-diary: remote')

  const ensure = async (): Promise<DiaryFace> => {
    await mountReady
    if (diary === undefined) throw new Error('dsh-diary: the diary Remote is not mounted')
    return diary
  }
  const unwrap = async <T>(call: (face: DiaryFace) => Promise<RemoteResult<T>>): Promise<T> => {
    const result = await call(await ensure())
    if (!result.ok) throw new Error(`dsh-diary: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-diary',
    order: 60,
    label: () => t('nav'),
    locale: NS,
    inject: (): DiarySectionInjected => ({
      getDirectory: () => unwrap(face => face.getDirectory()),
      listTemplates: () => unwrap(face => face.listTemplates()),
      getTemplate: name => unwrap(face => face.getTemplate(name)).then(value => value.content),
      setTemplate: (name, content) => unwrap(face => face.setTemplate(name, content)).then(() => undefined),
      deleteTemplate: name => unwrap(face => face.deleteTemplate(name)).then(() => undefined),
    }),
  }, DiarySection))

  // The standalone board: its own React root (a portal) so it lives outside
  // the conversation. Plain callbacks + the locale translator cross into it.
  const boardInjected: DiaryBoardInjected = {
    listEntries: () => unwrap(face => face.listEntries()),
    getEntry: (date, slug) => unwrap(face => face.getEntry(date, slug)),
    createEntry: input => unwrap(face => face.createEntry(input)).then(() => undefined),
    deleteEntry: (date, slug) => unwrap(face => face.deleteEntry(date, slug)).then(() => undefined),
    listTemplates: () => unwrap(face => face.listTemplates()),
    getTemplate: name => unwrap(face => face.getTemplate(name)).then(value => value.content),
  }
  const boardT = t as unknown as (key: string, params?: Record<string, string>) => string
  const boardHost = document.createElement('div')
  boardHost.id = 'dsh-diary-board-root'
  document.body.appendChild(boardHost)
  const boardRoot = createRoot(boardHost)
  boardRoot.render(createElement(DiaryBoard, { ...boardInjected, t: boardT }))
  ctx.effect(() => () => {
    boardRoot.unmount()
    boardHost.remove()
  }, 'dsh-diary: board')
}
