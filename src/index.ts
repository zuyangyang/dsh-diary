/**
 * Diary plugin for DeepSeek Harness.
 *
 * Registers a small family of model-facing tools on `ctx.tools` for a daily
 * markdown journal: create, list, read, update, delete, full-text search, and
 * claim. Entries are markdown files named `YYYY-MM-DD[-slug].md` (one per day
 * unless a `slug` disambiguates several entries on the same date) stored under a
 * configurable directory. Each file carries optional YAML frontmatter
 * (`title`, `date`, `tags`) followed by the markdown body.
 *
 * Identity and read scope come from the optional dsh-family-auth sibling
 * plugin. When it is loaded each household member gets their own directory under
 * the diary root, reads are limited to the member's scope, and anything written
 * before anyone was identified waits in a shared pending bucket until the
 * household owner claims it (`diary_claim`). Without that plugin the plugin keeps
 * the historical single-user layout, which is what a one-person diary needs.
 * @module dsh-diary
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: brings the `ctx.typert` Context merge into this program.
import type {} from '@deepseek-ai/dsh-typert-registry'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import {
  AUTH_MODULE,
  createAuthView,
  isUsableOwnerId,
  type DiaryAuthConfig,
  type DiaryAuthView,
  type DiaryBucket,
  type DiaryExec,
  type FamilyAuth,
} from './auth.ts'
import { TYPERT_MANIFEST } from './typert.ts'

export const name = 'dsh-diary'
export const inject = ['tools', 'typert']

/** Deployment configuration for the diary plugin. */
export interface Config {
  /** Absolute (or `~`-prefixed) directory holding the diary markdown files. */
  directory?: string
  /**
   * Whether dsh-family-auth is required. `single` (the default) makes the
   * service optional: without it the diary keeps the historical shared layout,
   * with it the diary is per-member. `auth` requires the service and every tool
   * refuses when it is missing, instead of silently sharing one directory.
   */
  identity?: 'single' | 'auth'
  /**
   * What the web board may show. The browser panel carries no tool execution, so
   * it can never resolve a member: `all` (the default) is the operator's console
   * and lists every owner's entries, `pending` lists only the unclaimed bucket,
   * `off` refuses. This is an acknowledged limitation, documented in the README,
   * not isolation.
   */
  panel?: 'all' | 'pending' | 'off'
  /**
   * Owner id used for the shared pending bucket, matching dsh-family-auth's own
   * `fallbackOwner` (usually `default`). Entries written before anyone was
   * identified live in `<directory>/_pending/` under this id.
   */
  fallbackOwner?: string
}

/** Parsed frontmatter fields the plugin reads and writes. */
interface Frontmatter {
  title?: string
  date?: string
  tags?: string[]
}

/** Metadata for one diary entry, independent of its body. */
interface EntryMeta {
  date: string
  slug: string
  title: string
  tags: string[]
  fileName: string
  path: string
  sizeBytes: number
  modifiedAt: string
}

/** One panel row: entry metadata plus the owner bucket it came from. */
interface PanelEntryMeta extends EntryMeta {
  /** Bucket id (an owner id, or '' for the historical files at the root). */
  owner: string
  /** Owner display name shown next to the entry. */
  ownerName: string
}

/** A diary entry resolved from disk: metadata plus its body. */
interface ResolvedEntry {
  fileName: string
  path: string
  meta: Frontmatter
  body: string
  stat: Awaited<ReturnType<typeof stat>>
}

/** Live handle to the optional dsh-family-auth service, filled by the deferred injection. */
interface AuthSlot {
  auth: FamilyAuth | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Default diary root: $DSH_HOME/diaries, or ~/.dsh/diaries when unset. */
function defaultDirectory(): string {
  const home = (process.env.DSH_HOME ?? '').trim()
  return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'diaries')
}

/** Expand a leading `~` / `~/` against the OS home, then resolve absolutely. */
function resolveDirectory(directory: string | undefined): string {
  const selected = (directory ?? '').trim()
  if (selected.length === 0) return resolve(defaultDirectory())
  let expanded = selected
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2))
  return resolve(expanded)
}

/** Local date as `YYYY-MM-DD` (authoritative for "today"). */
function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Normalize a user slug into a filesystem-safe filename suffix. */
function sanitizeSlug(slug: string): string {
  return slug.trim()
    .replace(/[/\\:*?"<>|#\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Filename for one (date, slug) pair. */
function fileNameFor(date: string, slug?: string): string {
  const suffix = slug ? `-${sanitizeSlug(slug)}` : ''
  return `${date}${suffix}.md`
}

/** Parse a diary filename back into `{ date, slug }`, or null when not a diary file. */
function parseFileName(fileName: string): { date: string; slug: string } | null {
  if (!fileName.endsWith('.md')) return null
  const stem = fileName.slice(0, -'.md'.length)
  const match = /^(\d{4}-\d{2}-\d{2})(?:-(.+))?$/.exec(stem)
  if (!match) return null
  return { date: match[1]!, slug: match[2] ?? '' }
}

/** Split a diary file into its frontmatter and body. */
function parseDocument(content: string): { meta: Frontmatter; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { meta: {}, body: content }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { meta: {}, body: content }
  let meta: Frontmatter = {}
  try {
    const parsed: unknown = loadYaml(match[1]!)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      meta = {
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
        ...(typeof record.date === 'string' ? { date: record.date } : {}),
        ...(Array.isArray(record.tags) ? { tags: record.tags.map(String) } : {}),
      }
    }
  } catch {
    meta = {}
  }
  // The closing fence is followed by a blank separator line; drop exactly one
  // leading newline so a freshly serialized document round-trips byte-for-byte.
  const body = content.slice(match[0].length).replace(/^\r?\n/, '')
  return { meta, body }
}

/** Serialize a diary entry back to disk. */
function serializeDocument(meta: Frontmatter, body: string): string {
  const frontmatter: Record<string, unknown> = {}
  if (meta.title !== undefined) frontmatter.title = meta.title
  if (meta.date !== undefined) frontmatter.date = meta.date
  if (meta.tags !== undefined && meta.tags.length > 0) frontmatter.tags = meta.tags
  if (Object.keys(frontmatter).length === 0) return body
  const yaml = dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd()
  return `---\n${yaml}\n---\n\n${body}`
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new Error(`invalid date ${JSON.stringify(date)}: expected YYYY-MM-DD`)
  }
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid month ${month}: expected an integer 1-12`)
  }
}

/** List diary files under one bucket directory, newest first. */
async function listDiaryFiles(root: string): Promise<string[]> {
  let names: Dirent[]
  try {
    names = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names
    .filter(entry => entry.isFile() && parseFileName(entry.name) !== null)
    .map(entry => entry.name)
    .sort()
    .reverse()
}

/** Resolve one entry, throwing a clear error when it is missing. */
async function resolveEntry(root: string, date: string, slug: string | undefined, signal?: AbortSignal): Promise<ResolvedEntry> {
  assertDate(date)
  const fileName = fileNameFor(date, slug)
  const filePath = join(root, fileName)
  let body: string
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    body = await readFile(filePath, { encoding: 'utf8', ...(signal ? { signal } : {}) })
    fileStat = await stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`diary entry not found: ${fileName}`)
    }
    throw error
  }
  const { meta } = parseDocument(body)
  return { fileName, path: filePath, meta, body, stat: fileStat }
}

/**
 * Resolve one entry, or null when this bucket has none.
 *
 * A read that spans several members must try every directory in scope without
 * treating "not in this member's directory" as an error.
 */
async function resolveEntryOrNull(root: string, date: string, slug: string | undefined, signal?: AbortSignal): Promise<ResolvedEntry | null> {
  assertDate(date)
  const filePath = join(root, fileNameFor(date, slug))
  try {
    await stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return resolveEntry(root, date, slug, signal)
}

/** Whether a path exists. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Move one diary file into another owner's directory.
 *
 * `rename` replaces an existing destination silently, and a diary entry is gone
 * once replaced, so the destination is checked first and a conflict is reported
 * instead of resolved. `EXDEV` only appears when the diary root spans
 * filesystems (a mount inside it), where copy-then-delete is the portable path.
 */
async function moveFile(from: string, to: string): Promise<void> {
  if (await pathExists(to)) {
    const conflict = new Error('destination exists: ' + to) as NodeJS.ErrnoException
    conflict.code = 'EEXIST'
    throw conflict
  }
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to)
    await rm(from)
  }
}

/**
 * Resolve the one entry a (date, slug, owner) selector names among the buckets
 * this execution may read.
 *
 * Without an owner the selector can match entries in several members'
 * directories — two people journaling on the same day is the normal case, not an
 * edge case. Merging them silently would hand back someone else's day, so an
 * ambiguity is an error that names the owners instead.
 */
async function locateEntry(
  view: DiaryAuthView,
  date: string,
  slug: string | undefined,
  ownerToken: string | undefined,
  signal?: AbortSignal,
): Promise<{ bucket: DiaryBucket; entry: ResolvedEntry }> {
  assertDate(date)
  let candidates: DiaryBucket[]
  const token = (ownerToken ?? '').trim()
  if (token.length > 0) {
    const bucket = await view.bucketByToken(token)
    if (bucket === null) {
      throw new Error('日记：找不到「' + token + '」的日记目录，或者没有权限查看')
    }
    candidates = [bucket]
  } else {
    candidates = await view.readBuckets()
  }
  const found: Array<{ bucket: DiaryBucket; entry: ResolvedEntry }> = []
  for (const bucket of candidates) {
    const entry = await resolveEntryOrNull(bucket.root, date, slug, signal)
    if (entry !== null) found.push({ bucket, entry })
  }
  if (found.length === 0) throw new Error(`diary entry not found: ${fileNameFor(date, slug)}`)
  if (found.length > 1) {
    const labels = found.map(item => item.bucket.label.length > 0 ? item.bucket.label : '旧日记').join('、')
    throw new Error('这篇日记在多个成员的目录里都有（' + labels + '）；请用 owner 指定是谁的')
  }
  return found[0]!
}

/** Read metadata for one file name without throwing on frontmatter errors. */
async function readMeta(root: string, fileName: string): Promise<EntryMeta> {
  const filePath = join(root, fileName)
  const parsed = parseFileName(fileName)!
  let meta: Frontmatter = {}
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    const content = await readFile(filePath, { encoding: 'utf8' })
    meta = parseDocument(content).meta
    fileStat = await stat(filePath)
  } catch {
    fileStat = await stat(filePath)
  }
  return {
    date: parsed.date,
    slug: parsed.slug,
    title: meta.title ?? '',
    tags: meta.tags ?? [],
    fileName,
    path: filePath,
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
  }
}

/** Ensure one bucket directory exists. */
async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
}

/** Templates directory under the diary root (household-shared, never per-member). */
function templatesDir(root: string): string {
  return join(root, 'templates')
}

/** Normalize a template name into a safe file stem. */
function sanitizeTemplateName(name: string): string {
  return name.trim()
    .replace(/[/\\:*?"<>|#\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Absolute path of one template file; rejects an empty sanitized name. */
function templatePath(root: string, name: string): string {
  const stem = sanitizeTemplateName(name)
  if (stem.length === 0) {
    throw new Error('template name must contain at least one non-whitespace character')
  }
  return join(templatesDir(root), `${stem}.md`)
}

/** One template's metadata, without its content. */
interface TemplateMeta {
  name: string
  fileName: string
  path: string
  sizeBytes: number
  modifiedAt: string
}

/** List template files under the root (empty when the directory is absent). */
async function listTemplates(root: string): Promise<TemplateMeta[]> {
  const dir = templatesDir(root)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const templates: TemplateMeta[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const fileStat = await stat(join(dir, entry.name))
    templates.push({
      name: entry.name.slice(0, -'.md'.length),
      fileName: entry.name,
      path: join(dir, entry.name),
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    })
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

/** Substitution context for template placeholders. */
interface TemplateVars {
  date: string
  title: string
  tags: string[]
  slug: string
}

/**
 * Render a template's `{{name}}` placeholders against one entry's resolved
 * values. Unknown placeholders are left verbatim. `{{datetime}}` and
 * `{{time}}` use the process clock, so this helper only ever runs inside a
 * tool `execute` (never a replay-safe presenter).
 */
function renderTemplate(source: string, vars: TemplateVars): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const [year, month, day] = vars.date.split('-')
  const replacements: Record<string, string> = {
    date: vars.date,
    title: vars.title,
    tags: vars.tags.join(', '),
    slug: vars.slug,
    year: year ?? '',
    month: month ?? '',
    day: day ?? '',
    datetime: now.toISOString(),
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  }
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => replacements[key] ?? whole)
}

/** Panel mode with the documented default applied. */
function panelModeOf(config: Config): 'all' | 'pending' | 'off' {
  return config.panel === 'pending' || config.panel === 'off' ? config.panel : 'all'
}

/**
 * The `diary` Host Remote service (wire namespace `diary`). Registered as a
 * `TypertRemoteService` so the Host Gateway's source-mode discovery exports its
 * `@Remote` methods to the Web client under `/api/diary/<method>` from the
 * hand-written manifest in typert.ts. It exposes directory + template
 * management to the settings section; entry content stays with the tools.
 *
 * Web methods receive no tool execution, so they cannot resolve an actor. The
 * panel is the operator's console: it lists every member's entries (labelled
 * with the owner) or only the pending bucket, and panel-created entries land in
 * the pending bucket. That is an honest limitation, not isolation.
 */
class DiaryRuntime extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly config: DiaryAuthConfig,
    private readonly panel: 'all' | 'pending' | 'off',
    private readonly identity: AuthSlot,
  ) {
    super(ctx, 'diary')
  }

  /** A view for the panel: no execution, therefore no actor. */
  private view(): DiaryAuthView {
    return createAuthView({ auth: this.identity.auth, config: this.config })
  }

  /** The view, refused when the deployment disabled the panel. */
  private ensurePanel(): DiaryAuthView {
    if (this.panel === 'off') {
      throw new Error('日记看板已关闭：panel 配置为 off，请在 profile 里改回 all 或 pending')
    }
    return this.view()
  }

  /** Find one entry among the buckets the panel may show. */
  private async locate(date: string, slug: string, owner: string | undefined): Promise<{ bucket: DiaryBucket; entry: ResolvedEntry }> {
    assertDate(date)
    const buckets = await this.ensurePanel().consoleBuckets(this.panel === 'pending' ? 'pending' : 'all')
    let candidates = buckets
    if (owner !== undefined) {
      const wanted = owner.trim()
      const bucket = buckets.find(candidate => candidate.id === wanted || candidate.label === wanted)
      if (bucket === undefined) {
        throw new Error('日记看板里没有「' + owner + '」这个归属')
      }
      candidates = [bucket]
    }
    const normalizedSlug = slug.length > 0 ? slug : undefined
    const found: Array<{ bucket: DiaryBucket; entry: ResolvedEntry }> = []
    for (const bucket of candidates) {
      const entry = await resolveEntryOrNull(bucket.root, date, normalizedSlug)
      if (entry !== null) found.push({ bucket, entry })
    }
    if (found.length === 0) throw new Error(`diary entry not found: ${fileNameFor(date, normalizedSlug)}`)
    if (found.length > 1) {
      throw new Error('日记看板：这个日期在多个成员的目录里都有，请带上「归属」再打开')
    }
    return found[0]!
  }

  @Remote
  async getDirectory(): Promise<{ directory: string; templatesDirectory: string }> {
    return { directory: this.config.directory, templatesDirectory: templatesDir(this.config.directory) }
  }

  @Remote
  async listTemplates(): Promise<readonly TemplateMeta[]> {
    return listTemplates(this.config.directory)
  }

  @Remote
  async getTemplate(name: string): Promise<{ name: string; content: string }> {
    const filePath = templatePath(this.config.directory, name)
    let content: string
    try {
      content = await readFile(filePath, { encoding: 'utf8' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`diary template not found: ${name}`)
      }
      throw error
    }
    return { name: sanitizeTemplateName(name), content }
  }

  @Remote
  async setTemplate(name: string, content: string): Promise<{ name: string; sizeBytes: number }> {
    const cleanName = sanitizeTemplateName(name)
    if (cleanName.length === 0) {
      throw new Error('template name must contain at least one non-whitespace character')
    }
    await ensureRoot(this.config.directory)
    await mkdir(templatesDir(this.config.directory), { recursive: true })
    const filePath = join(templatesDir(this.config.directory), `${cleanName}.md`)
    await writeFile(filePath, content, { encoding: 'utf8' })
    const fileStat = await stat(filePath)
    return { name: cleanName, sizeBytes: fileStat.size }
  }

  @Remote
  async deleteTemplate(name: string): Promise<{ deleted: boolean }> {
    const filePath = templatePath(this.config.directory, name)
    try {
      await rm(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`diary template not found: ${name}`)
      }
      throw error
    }
    return { deleted: true }
  }

  @Remote
  async listEntries(): Promise<readonly PanelEntryMeta[]> {
    const view = this.ensurePanel()
    const buckets = await view.consoleBuckets(this.panel === 'pending' ? 'pending' : 'all')
    const entries: PanelEntryMeta[] = []
    for (const bucket of buckets) {
      for (const fileName of await listDiaryFiles(bucket.root)) {
        entries.push({ ...(await readMeta(bucket.root, fileName)), owner: bucket.id, ownerName: bucket.label })
      }
    }
    // Newest first across every member, so the console reads like one diary.
    entries.sort((a, b) => (a.date === b.date ? a.ownerName.localeCompare(b.ownerName) : (a.date < b.date ? 1 : -1)))
    return entries
  }

  @Remote
  async getEntry(date: string, slug: string, owner?: string): Promise<{ date: string; slug: string; title: string; tags: string[]; content: string }> {
    const located = await this.locate(date, slug, owner)
    const parsed = parseFileName(located.entry.fileName)!
    const { meta, body } = parseDocument(located.entry.body)
    return { date, slug: parsed.slug, title: meta.title ?? '', tags: meta.tags ?? [], content: body }
  }

  @Remote
  async createEntry(input: { date?: string; title?: string; slug?: string; content?: string; template?: string; tags?: string[] }): Promise<{ path: string; date: string; slug: string; title: string; tags: string[] }> {
    const bucket = this.ensurePanel().consoleWriteBucket()
    const date = input.date?.trim() || todayIso()
    assertDate(date)
    const slug = sanitizeSlug(input.slug ?? '')
    const title = (input.title ?? '').trim()
    const tags = (input.tags ?? []).map(tag => String(tag).trim()).filter(tag => tag.length > 0)
    await ensureRoot(bucket.root)
    let body = ''
    if (input.template !== undefined && input.template.trim().length > 0) {
      const tpath = templatePath(this.config.directory, input.template)
      let source: string
      try {
        source = await readFile(tpath, { encoding: 'utf8' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`diary template not found: ${input.template}`)
        }
        throw error
      }
      body = renderTemplate(source, { date, title, tags, slug })
    }
    if (input.content !== undefined && input.content.length > 0) {
      body = body.length > 0 ? `${body.replace(/\s+$/, '')}\n\n${input.content}` : input.content
    }
    if (body.length === 0) {
      throw new Error('createEntry requires content, or a template that renders a non-empty body')
    }
    const fileName = fileNameFor(date, slug)
    const filePath = join(bucket.root, fileName)
    const meta: Frontmatter = { date, ...(title ? { title } : {}), ...(tags.length > 0 ? { tags } : {}) }
    const document = serializeDocument(meta, body)
    try {
      await writeFile(filePath, document, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`diary entry already exists: ${fileName} (choose another date or a slug)`)
      }
      throw error
    }
    return { path: filePath, date, slug, title, tags }
  }

  @Remote
  async deleteEntry(date: string, slug: string, owner?: string): Promise<{ deleted: boolean }> {
    const located = await this.locate(date, slug, owner)
    await rm(located.entry.path)
    return { deleted: true }
  }
}

/** Register the diary tool family on the tool registry. */
export function apply(ctx: Context, config: Config = {}): void {
  const root = resolveDirectory(config.directory)
  const authConfig: DiaryAuthConfig = {
    directory: root,
    identity: config.identity === 'auth' ? 'auth' : 'single',
    fallbackOwner: (config.fallbackOwner ?? '').trim() || 'default',
  }
  const panel = panelModeOf(config)

  // The identity service arrives asynchronously (and may be replaced on a plugin
  // reload), so the tools and the panel close over this slot rather than a
  // snapshot of the service taken at boot.
  const identity: AuthSlot = { auth: null }
  const logger = {
    warn(message: string): void {
      try {
        ctx.logger?.warn?.(message)
      } catch {
        // Logging must never turn a failed read into a failed call.
      }
    },
  }
  const viewFor = (exec?: DiaryExec): DiaryAuthView => createAuthView({ auth: identity.auth, config: authConfig, exec, logger })

  // dsh-family-auth is optional. When the profile provides it, it owns identity
  // and every read is scoped; when it is absent a `single` deployment behaves
  // exactly as before, which is right for one person's diary. Injection is
  // fire-only-if-available: this plugin never imports the sibling package.
  ctx.inject(['familyAuth'], (authCtx) => {
    const service = (authCtx as Context & { readonly familyAuth?: FamilyAuth | null }).familyAuth ?? null
    if (service === null) return
    identity.auth = service
    if (typeof service.defineModule === 'function') {
      try {
        service.defineModule({ name: AUTH_MODULE, title: '日记' })
      } catch {
        // The module declaration is advisory metadata; a sibling version that
        // rejects it must not take the diary down with it.
      }
    }
    authCtx.effect(() => () => {
      if (identity.auth === service) identity.auth = null
    }, 'dsh-diary: family-auth')
    ctx.logger?.info?.('[dsh-diary] identity and read scope come from dsh-family-auth')
  })

  // The browser-facing Remote namespace: mount the runtime and claim its wire
  // endpoints through the strict registry.
  new DiaryRuntime(ctx, authConfig, panel, identity)
  ctx.effect(() => {
    // The manifest only feeds the settings panel's RPC. When another typert
    // contribution already claims the "diary" namespace, register() throws - and
    // a throw inside an activation effect takes the whole plugin down, losing the
    // diary tools over a panel. Degrade to "no panel" instead.
    let dispose: (() => unknown) | undefined
    try {
      dispose = ctx.typert.register(TYPERT_MANIFEST)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-diary] typert manifest skipped: '
        + (error instanceof Error ? error.message : String(error)))
    }
    return () => { void dispose?.() }
  }, 'dsh-diary: typert manifest')

  ctx.tools.register(defineTool({
    name: 'diary_create',
    description: 'Create a new diary entry as a markdown file. Entries are stored as '
      + '`YYYY-MM-DD[-slug].md` under the configured diary directory; one entry per day by '
      + 'default, with an optional `slug` to keep several entries on the same date. The entry '
      + 'gets YAML frontmatter (`title`, `date`, `tags`) followed by the markdown body. A named '
      + '`template` (managed by the diary_template_* tools) may seed the body via placeholders. '
      + 'With dsh-family-auth the entry belongs to the speaking member; an unidentified '
      + 'conversation writes into the shared pending bucket instead, which the household owner '
      + 'can hand to a member with diary_claim.',
    parameters: {
      date: { type: 'string', description: 'Entry date as YYYY-MM-DD. Defaults to today when omitted.' },
      title: { type: 'string', description: 'Optional entry title recorded in the frontmatter.' },
      slug: { type: 'string', description: 'Optional short slug for a second entry on the same date (e.g. "work").' },
      content: { type: 'string', description: 'The markdown body of the entry.' },
      template: { type: 'string', description: 'Optional template name whose rendered body seeds the entry; `content`, when also given, is appended after it.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional list of tags recorded in the frontmatter.' },
      overwrite: { type: 'boolean', description: 'Overwrite an existing entry for the same date/slug. Defaults to false (refuses to overwrite).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          date: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          title: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          owner: { type: 'string', required: true },
          pending: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pending
          ? `Created diary entry ${value.path}（未识别成员，先放进待认领目录；户主可用 diary_claim 认领）`
          : `Created diary entry ${value.path}${value.owner === '' ? '' : `（归属：${value.owner}）`}`,
      }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      const date = args.date?.trim() || todayIso()
      assertDate(date)
      const slug = sanitizeSlug(args.slug ?? '')
      const title = (args.title ?? '').trim()
      const tags = (args.tags ?? []).map(tag => String(tag).trim()).filter(tag => tag.length > 0)
      // The write target is resolved before the body is built so an unidentified
      // conversation that cannot write fails before doing any work.
      const bucket = view.writeBucket()
      await ensureRoot(bucket.root)
      let body = ''
      if (args.template !== undefined && args.template.trim().length > 0) {
        const tpath = templatePath(root, args.template)
        let source: string
        try {
          source = await readFile(tpath, { encoding: 'utf8', signal: exec.signal })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`diary template not found: ${args.template} (create it with diary_template_set)`)
          }
          throw error
        }
        body = renderTemplate(source, { date, title, tags, slug })
      }
      if (args.content !== undefined && args.content.length > 0) {
        body = body.length > 0 ? `${body.replace(/\s+$/, '')}\n\n${args.content}` : args.content
      }
      if (body.length === 0) {
        throw new Error('diary_create requires `content`, or a `template` that renders a non-empty body')
      }
      const fileName = fileNameFor(date, slug)
      const filePath = join(bucket.root, fileName)
      const meta: Frontmatter = { date, ...(title ? { title } : {}), ...(tags.length > 0 ? { tags } : {}) }
      const document = serializeDocument(meta, body)
      if (args.overwrite) {
        await writeFile(filePath, document, { encoding: 'utf8', signal: exec.signal })
      } else {
        try {
          await writeFile(filePath, document, { encoding: 'utf8', signal: exec.signal, flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`diary entry already exists: ${fileName} (pass overwrite: true to replace it, or use diary_update)`)
          }
          throw error
        }
      }
      return { path: filePath, date, slug, title, tags, owner: bucket.label, pending: bucket.pending }
    },
    presentCall: args => (args.date
      ? {
        card: 'diff',
        title: 'New diary entry',
        diffs: [{
          path: fileNameFor(args.date, args.slug),
          oldText: null,
          newText: serializeDocument({
            date: args.date,
            ...(args.title ? { title: args.title } : {}),
            ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
          }, args.content ?? (args.template ? `{{ rendered from template "${args.template}" }}` : '')),
        }],
      }
      : undefined),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_list',
    description: 'List diary entries with metadata (date, slug, title, tags, size, modification time, '
      + 'and whose entry it is). Filter by year/month, tag, or a substring matched against the title '
      + 'and filename. With dsh-family-auth only the entries this member may read are listed, and '
      + 'every row carries the owner name so a shared list is never ambiguous.',
    parameters: {
      year: { type: 'integer', description: 'Optional year filter (e.g. 2026).' },
      month: { type: 'integer', description: 'Optional month filter 1-12; only meaningful with `year`.' },
      tag: { type: 'string', description: 'Optional tag filter (exact, case-insensitive).' },
      query: { type: 'string', description: 'Optional substring matched against the title or filename.' },
      limit: { type: 'integer', description: 'Maximum number of entries to return. Defaults to 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                fileName: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                modifiedAt: { type: 'string', required: true },
                owner: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const counts = new Map<string, number>()
        for (const entry of value.entries) {
          if (entry.owner === '') continue
          counts.set(entry.owner, (counts.get(entry.owner) ?? 0) + 1)
        }
        const breakdown = [...counts.entries()].map(([owner, count]) => `${owner} ${count} 篇`).join('、')
        return [{
          type: 'text',
          text: `Found ${value.total} diary entr${value.total === 1 ? 'y' : 'ies'}.${breakdown === '' ? '' : `（${breakdown}）`}`,
        }]
      },
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      if (args.month !== undefined) assertMonth(args.month)
      const limit = args.limit === undefined ? 100 : Math.max(1, Math.min(1000, Math.trunc(args.limit)))
      const tag = (args.tag ?? '').trim().toLowerCase()
      const query = (args.query ?? '').trim().toLowerCase()
      const year = args.year
      const month = args.month
      const buckets = await view.readBuckets()
      const rows: Array<EntryMeta & { owner: string }> = []
      for (const bucket of buckets) {
        for (const fileName of await listDiaryFiles(bucket.root)) {
          const parsed = parseFileName(fileName)!
          if (year !== undefined || month !== undefined) {
            const [fileYear, fileMonth] = parsed.date.split('-').map(Number)
            if (year !== undefined && fileYear !== year) continue
            if (month !== undefined && fileMonth !== month) continue
          }
          const meta = await readMeta(bucket.root, fileName)
          if (tag && !meta.tags.some(t => t.toLowerCase() === tag)) continue
          if (query && !meta.title.toLowerCase().includes(query) && !meta.fileName.toLowerCase().includes(query)) continue
          rows.push({ ...meta, owner: bucket.label })
        }
      }
      rows.sort((a, b) => (a.date === b.date ? a.owner.localeCompare(b.owner) : (a.date < b.date ? 1 : -1)))
      const entries = rows.slice(0, limit)
      return {
        entries: entries.map(entry => ({
          date: entry.date,
          slug: entry.slug,
          title: entry.title,
          tags: entry.tags,
          fileName: entry.fileName,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
          owner: entry.owner,
        })),
        total: entries.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_read',
    description: 'Read one diary entry (its frontmatter and full markdown body) by date, plus the '
      + 'optional slug used when several entries share a date. With dsh-family-auth the entry is '
      + 'looked up only in the directories this member may read; when several members have an entry '
      + 'for the same date, pass `owner` (the owner name diary_list reported) to pick one.',
    parameters: {
      date: { type: 'string', required: true, description: 'Entry date as YYYY-MM-DD.' },
      slug: { type: 'string', description: 'Optional slug for a second entry on the same date.' },
      owner: { type: 'string', description: 'Whose entry, when several members share the date: the owner name from diary_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          date: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          title: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          content: { type: 'string', required: true },
          owner: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      const located = await locateEntry(view, args.date, args.slug, args.owner, exec.signal)
      const slug = parseFileName(located.entry.fileName)!.slug
      const { meta, body } = parseDocument(located.entry.body)
      return {
        path: located.entry.path,
        date: args.date,
        slug,
        title: meta.title ?? '',
        tags: meta.tags ?? [],
        content: body,
        owner: located.bucket.label,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read diary entry', kind: 'read', locations: [{ path: fileNameFor(args.date, args.slug) }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_update',
    description: 'Update an existing diary entry: replace the body, append text, or change its title '
      + 'and tags. Pass only the fields you want to change; at least one of `content`, `append`, '
      + '`title`, or `tags` is required. With dsh-family-auth only an entry this member may write '
      + '(their own, or one the household owner manages) can be updated.',
    parameters: {
      date: { type: 'string', required: true, description: 'Entry date as YYYY-MM-DD.' },
      slug: { type: 'string', description: 'Optional slug for a second entry on the same date.' },
      content: { type: 'string', description: 'Replacement markdown body (replaces the current body).' },
      append: { type: 'string', description: 'Text appended to the end of the current body.' },
      title: { type: 'string', description: 'New title; omit to keep the current title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list; omit to keep the current tags.' },
      owner: { type: 'string', description: 'Whose entry, when several members share the date: the owner name from diary_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          date: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          title: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          content: { type: 'string', required: true },
          owner: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Updated diary entry ${value.path}` }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      if (args.content === undefined && args.append === undefined && args.title === undefined && args.tags === undefined) {
        throw new Error('diary_update requires at least one of content, append, title, or tags')
      }
      const located = await locateEntry(view, args.date, args.slug, args.owner, exec.signal)
      view.assertWrite(located.bucket)
      const parsed = parseFileName(located.entry.fileName)!
      const { meta, body } = parseDocument(located.entry.body)
      const nextTitle = args.title !== undefined ? args.title.trim() : (meta.title ?? '')
      const nextTags = args.tags !== undefined
        ? args.tags.map(tag => String(tag).trim()).filter(tag => tag.length > 0)
        : (meta.tags ?? [])
      let nextBody = body
      if (args.content !== undefined) nextBody = args.content
      if (args.append !== undefined) nextBody = nextBody.endsWith('\n') ? nextBody + args.append : `${nextBody}\n${args.append}`
      const nextMeta: Frontmatter = {
        date: args.date,
        ...(nextTitle ? { title: nextTitle } : {}),
        ...(nextTags.length > 0 ? { tags: nextTags } : {}),
      }
      await writeFile(located.entry.path, serializeDocument(nextMeta, nextBody), { encoding: 'utf8', signal: exec.signal })
      return {
        path: located.entry.path,
        date: args.date,
        slug: parsed.slug,
        title: nextTitle,
        tags: nextTags,
        content: nextBody,
        owner: located.bucket.label,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Update diary entry', kind: 'edit', locations: [{ path: fileNameFor(args.date, args.slug) }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_delete',
    description: 'Delete a diary entry markdown file by date (and optional slug). This permanently '
      + 'removes the file. With dsh-family-auth only an entry this member may write can be deleted.',
    parameters: {
      date: { type: 'string', required: true, description: 'Entry date as YYYY-MM-DD.' },
      slug: { type: 'string', description: 'Optional slug for a second entry on the same date.' },
      owner: { type: 'string', description: 'Whose entry, when several members share the date: the owner name from diary_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          owner: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Deleted diary entry ${value.path}` }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      const located = await locateEntry(view, args.date, args.slug, args.owner)
      view.assertWrite(located.bucket)
      await rm(located.entry.path)
      return { deleted: true, path: located.entry.path, owner: located.bucket.label }
    },
    presentCall: args => ({ card: 'generic', title: 'Delete diary entry', kind: 'other', locations: [{ path: fileNameFor(args.date, args.slug) }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_search',
    description: 'Full-text search across diary entry bodies. Returns each matching file with the '
      + 'line number and the matching line (snippet), plus whose entry it is. With dsh-family-auth '
      + 'only the entries this member may read are searched.',
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive substring to find in entry bodies.' },
      limit: { type: 'integer', description: 'Maximum number of matches to return. Defaults to 50.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                snippet: { type: 'string', required: true },
                owner: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Found ${value.total} match${value.total === 1 ? '' : 'es'} across diary entries.` }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      const query = args.query
      if (query.trim().length === 0) {
        throw new Error('diary_search requires a non-empty query')
      }
      const limit = args.limit === undefined ? 50 : Math.max(1, Math.min(1000, Math.trunc(args.limit)))
      const buckets = await view.readBuckets()
      const matches: Array<{ date: string; slug: string; title: string; fileName: string; lineNumber: number; snippet: string; owner: string }> = []
      for (const bucket of buckets) {
        for (const fileName of await listDiaryFiles(bucket.root)) {
          const parsed = parseFileName(fileName)!
          let content: string
          try {
            content = await readFile(join(bucket.root, fileName), { encoding: 'utf8' })
          } catch {
            continue
          }
          const { meta, body } = parseDocument(content)
          const lines = body.split(/\r?\n/)
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!
            if (!line.toLowerCase().includes(query.toLowerCase())) continue
            matches.push({
              date: parsed.date,
              slug: parsed.slug,
              title: meta.title ?? '',
              fileName,
              lineNumber: index + 1,
              snippet: line.length > 240 ? `${line.slice(0, 240)}…` : line,
              owner: bucket.label,
            })
            if (matches.length >= limit) break
          }
          if (matches.length >= limit) break
        }
        if (matches.length >= limit) break
      }
      return { matches, total: matches.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_claim',
    description: '把待认领的日记转给某个家庭成员：未识别的对话写下的条目、以及老版本直接放在日记根目录里的条目，'
      + '都算待认领。只有户主能用；操作会真的把文件移动到该成员的目录里，移动之后只有该成员（和被授权的人）能读到。'
      + '不给日期就认领全部待认领的日记。',
    parameters: {
      member: { type: 'string', required: true, description: '认领给谁：家庭成员的名字。' },
      date: { type: 'string', description: '只认领这一天的（YYYY-MM-DD）；省略表示全部待认领日记。' },
      slug: { type: 'string', description: '配合 date 精确到同一天的某一篇。' },
      dry_run: { type: 'boolean', description: '只预览会移动哪些文件，不真的移动。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member: { type: 'string', required: true },
          claimed: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
              },
            },
          },
          skipped: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fileName: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.dryRun
          ? `预览：会把 ${value.entries.length} 篇日记移动给「${value.member}」，这次没有写入`
          : `已把 ${value.claimed} 篇日记移动给「${value.member}」${value.skipped.length > 0 ? `，${value.skipped.length} 篇因为目标位置已存在而跳过` : ''}`,
      }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      if (!view.authActive) {
        throw new Error('这个日记没有接入家庭权限（dsh-family-auth）：所有日记本来就是同一个人的，没有待认领的条目')
      }
      if (!view.isOwner()) {
        throw new Error('只有户主能认领待认领的日记')
      }
      const member = view.findMember(args.member)
      if (member === null) {
        throw new Error('成员表里没有「' + args.member + '」；先让户主在对话里把他加上')
      }
      if (member.id === view.pendingOwnerId || !isUsableOwnerId(member.id)) {
        throw new Error('「' + args.member + '」不是可以接收日记的家庭成员')
      }
      const rawDate = (args.date ?? '').trim()
      if (rawDate.length > 0) assertDate(rawDate)
      const rawSlug = (args.slug ?? '').trim()
      if (rawSlug.length > 0 && rawDate.length === 0) {
        throw new Error('diary_claim 要指定 slug 时必须同时给 date')
      }
      const wantedSlug = rawSlug.length > 0 ? sanitizeSlug(rawSlug) : ''
      if (rawSlug.length > 0 && wantedSlug.length === 0) {
        throw new Error('diary_claim 的 slug 不能为空')
      }

      const movable: Array<{ from: string; fileName: string }> = []
      for (const bucket of view.claimBuckets()) {
        for (const fileName of await listDiaryFiles(bucket.root)) {
          const parsed = parseFileName(fileName)!
          if (rawDate.length > 0 && parsed.date !== rawDate) continue
          if (wantedSlug.length > 0 && parsed.slug !== wantedSlug) continue
          movable.push({ from: join(bucket.root, fileName), fileName })
        }
      }

      const targetRoot = view.bucketFor(member.id).root
      const moved: Array<{ date: string; slug: string; fileName: string; from: string; to: string }> = []
      const skipped: Array<{ fileName: string; reason: string }> = []
      if (movable.length > 0 && args.dry_run !== true) await ensureRoot(targetRoot)

      for (const item of movable) {
        const parsed = parseFileName(item.fileName)!
        const to = join(targetRoot, item.fileName)
        if (args.dry_run === true) {
          moved.push({ date: parsed.date, slug: parsed.slug, fileName: item.fileName, from: item.from, to })
          continue
        }
        try {
          await moveFile(item.from, to)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            skipped.push({ fileName: item.fileName, reason: `「${member.name}」已经有这一篇了` })
            continue
          }
          throw error
        }
        moved.push({ date: parsed.date, slug: parsed.slug, fileName: item.fileName, from: item.from, to })
      }

      if (args.dry_run !== true && moved.length > 0) {
        view.record('manage', { allow: true, reason: 'claim' }, { ownerId: member.id })
      }
      return {
        member: member.name,
        claimed: args.dry_run === true ? 0 : moved.length,
        dryRun: args.dry_run === true,
        entries: moved,
        skipped,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_template_list',
    description: 'List the diary templates available to `diary_create`. Templates are markdown files '
      + 'under `<diary-directory>/templates/` whose placeholders get substituted on use. Templates are '
      + 'shared by the whole household, not per member.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          templates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                modifiedAt: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Found ${value.total} diary template${value.total === 1 ? '' : 's'}.` }],
    },
    async execute(_args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      const templates = await listTemplates(root)
      return {
        templates: templates.map(template => ({
          name: template.name,
          fileName: template.fileName,
          sizeBytes: template.sizeBytes,
          modifiedAt: template.modifiedAt,
        })),
        total: templates.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_template_read',
    description: 'Read one diary template\'s full markdown content, including any placeholders it contains.',
    parameters: {
      name: { type: 'string', required: true, description: 'Template name (without the .md extension).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      const filePath = templatePath(root, args.name)
      let content: string
      try {
        content = await readFile(filePath, { encoding: 'utf8', signal: exec.signal })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`diary template not found: ${args.name}`)
        }
        throw error
      }
      return { name: sanitizeTemplateName(args.name), content }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_template_set',
    description: 'Create or overwrite a diary template. The content is markdown and may use '
      + 'double-brace placeholders named `date`, `title`, `tags`, `slug`, `year`, `month`, '
      + '`day`, `datetime`, and `time`, substituted when `diary_create` applies the template. '
      + 'Templates are shared by the whole household.',
    parameters: {
      name: { type: 'string', required: true, description: 'Template name (stored as `<name>.md`).' },
      content: { type: 'string', required: true, description: 'Template markdown content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          sizeBytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Saved diary template ${value.name}` }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      view.assertSharedWrite()
      const name = sanitizeTemplateName(args.name)
      if (name.length === 0) {
        throw new Error('template name must contain at least one non-whitespace character')
      }
      await ensureRoot(root)
      await mkdir(templatesDir(root), { recursive: true })
      const filePath = join(templatesDir(root), `${name}.md`)
      await writeFile(filePath, args.content, { encoding: 'utf8', signal: exec.signal })
      const fileStat = await stat(filePath)
      return { name, path: filePath, sizeBytes: fileStat.size }
    },
    presentCall: args => ({ card: 'generic', title: 'Save diary template', kind: 'edit', locations: [{ path: `templates/${sanitizeTemplateName(args.name)}.md` }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_template_delete',
    description: 'Delete a diary template by name. This permanently removes its markdown file.',
    parameters: {
      name: { type: 'string', required: true, description: 'Template name (without the .md extension).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Deleted diary template ${value.path}` }],
    },
    async execute(args, exec) {
      const view = viewFor(exec)
      view.ensureReady()
      view.assertSharedWrite()
      const filePath = templatePath(root, args.name)
      try {
        await rm(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`diary template not found: ${args.name}`)
        }
        throw error
      }
      return { deleted: true, path: filePath }
    },
    presentCall: args => ({ card: 'generic', title: 'Delete diary template', kind: 'delete', locations: [{ path: `templates/${sanitizeTemplateName(args.name)}.md` }] }),
  }))
}
