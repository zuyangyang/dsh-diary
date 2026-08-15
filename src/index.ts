/**
 * Diary plugin for DeepSeek Harness.
 *
 * Registers a small family of model-facing tools on `ctx.tools` for a daily
 * markdown journal: create, list, read, update, delete, and full-text search.
 * Entries are markdown files named `YYYY-MM-DD[-slug].md` (one per day unless a
 * `slug` disambiguates several entries on the same date) stored under a
 * configurable directory. Each file carries optional YAML frontmatter
 * (`title`, `date`, `tags`) followed by the markdown body.
 *
 * @module dsh-diary
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: brings the `ctx.typert` Context merge into this program.
import type {} from '@deepseek-ai/dsh-typert-registry'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import { TYPERT_MANIFEST } from './typert.ts'

export const name = 'dsh-diary'
export const inject = ['tools', 'typert']

/** Deployment configuration for the diary plugin. */
export interface Config {
  /** Absolute (or `~`-prefixed) directory holding the diary markdown files. */
  directory?: string
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

/** A diary entry resolved from disk: metadata plus its body. */
interface ResolvedEntry {
  fileName: string
  path: string
  meta: Frontmatter
  body: string
  stat: Awaited<ReturnType<typeof stat>>
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

/** List diary files under the root, newest first. */
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

/** Ensure the diary root exists. */
async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
}

/** Templates directory under the diary root. */
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

/**
 * The `diary` Host Remote service (wire namespace `diary`). Registered as a
 * `TypertRemoteService` so the Host Gateway's source-mode discovery exports its
 * `@Remote` methods to the Web client under `/api/diary/<method>` from the
 * hand-written manifest in typert.ts. It exposes directory + template
 * management to the settings section; entry content stays with the tools.
 */
class DiaryRuntime extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly root: string,
  ) {
    super(ctx, 'diary')
  }

  @Remote
  async getDirectory(): Promise<{ directory: string; templatesDirectory: string }> {
    return { directory: this.root, templatesDirectory: templatesDir(this.root) }
  }

  @Remote
  async listTemplates(): Promise<readonly TemplateMeta[]> {
    return listTemplates(this.root)
  }

  @Remote
  async getTemplate(name: string): Promise<{ name: string; content: string }> {
    const filePath = templatePath(this.root, name)
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
    await ensureRoot(this.root)
    await mkdir(templatesDir(this.root), { recursive: true })
    const filePath = join(templatesDir(this.root), `${cleanName}.md`)
    await writeFile(filePath, content, { encoding: 'utf8' })
    const fileStat = await stat(filePath)
    return { name: cleanName, sizeBytes: fileStat.size }
  }

  @Remote
  async deleteTemplate(name: string): Promise<{ deleted: boolean }> {
    const filePath = templatePath(this.root, name)
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
  async listEntries(): Promise<readonly EntryMeta[]> {
    const files = await listDiaryFiles(this.root)
    const entries: EntryMeta[] = []
    for (const fileName of files) {
      entries.push(await readMeta(this.root, fileName))
    }
    return entries
  }

  @Remote
  async getEntry(date: string, slug: string): Promise<{ date: string; slug: string; title: string; tags: string[]; content: string }> {
    const entry = await resolveEntry(this.root, date, slug.length > 0 ? slug : undefined)
    const parsed = parseFileName(entry.fileName)!
    const { meta, body } = parseDocument(entry.body)
    return { date, slug: parsed.slug, title: meta.title ?? '', tags: meta.tags ?? [], content: body }
  }

  @Remote
  async createEntry(input: { date?: string; title?: string; slug?: string; content?: string; template?: string; tags?: string[] }): Promise<{ path: string; date: string; slug: string; title: string; tags: string[] }> {
    const date = input.date?.trim() || todayIso()
    assertDate(date)
    const slug = sanitizeSlug(input.slug ?? '')
    const title = (input.title ?? '').trim()
    const tags = (input.tags ?? []).map(tag => String(tag).trim()).filter(tag => tag.length > 0)
    await ensureRoot(this.root)
    let body = ''
    if (input.template !== undefined && input.template.trim().length > 0) {
      const tpath = templatePath(this.root, input.template)
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
    const filePath = join(this.root, fileName)
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
  async deleteEntry(date: string, slug: string): Promise<{ deleted: boolean }> {
    assertDate(date)
    const fileName = fileNameFor(date, slug.length > 0 ? slug : undefined)
    const filePath = join(this.root, fileName)
    try {
      await rm(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`diary entry not found: ${fileName}`)
      }
      throw error
    }
    return { deleted: true }
  }
}

/** Register the diary tool family on the tool registry. */
export function apply(ctx: Context, config: Config = {}): void {
  const root = resolveDirectory(config.directory)

  // The browser-facing Remote namespace: mount the runtime and claim its wire
  // endpoints through the strict registry.
  new DiaryRuntime(ctx, root)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'dsh-diary: typert manifest')

  ctx.tools.register(defineTool({
    name: 'diary_create',
    description: 'Create a new diary entry as a markdown file. Entries are stored as '
      + '`YYYY-MM-DD[-slug].md` under the configured diary directory; one entry per day by '
      + 'default, with an optional `slug` to keep several entries on the same date. The entry '
      + 'gets YAML frontmatter (`title`, `date`, `tags`) followed by the markdown body. A named '
      + '`template` (managed by the diary_template_* tools) may seed the body via placeholders.',
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created diary entry ${value.path}` }],
    },
    async execute(args, exec) {
      const date = args.date?.trim() || todayIso()
      assertDate(date)
      const slug = sanitizeSlug(args.slug ?? '')
      const title = (args.title ?? '').trim()
      const tags = (args.tags ?? []).map(tag => String(tag).trim()).filter(tag => tag.length > 0)
      await ensureRoot(root)
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
      const filePath = join(root, fileName)
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
      return { path: filePath, date, slug, title, tags }
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
    description: 'List diary entries with metadata (date, slug, title, tags, size, modification time). '
      + 'Filter by year/month, tag, or a substring matched against the title and filename.',
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
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Found ${value.total} diary entr${value.total === 1 ? 'y' : 'ies'}.` }],
    },
    async execute(args) {
      if (args.month !== undefined) assertMonth(args.month)
      const limit = args.limit === undefined ? 100 : Math.max(1, Math.min(1000, Math.trunc(args.limit)))
      const files = await listDiaryFiles(root)
      const tag = (args.tag ?? '').trim().toLowerCase()
      const query = (args.query ?? '').trim().toLowerCase()
      const year = args.year
      const month = args.month
      const entries: EntryMeta[] = []
      for (const fileName of files) {
        const parsed = parseFileName(fileName)!
        if (year !== undefined || month !== undefined) {
          const [fileYear, fileMonth] = parsed.date.split('-').map(Number)
          if (year !== undefined && fileYear !== year) continue
          if (month !== undefined && fileMonth !== month) continue
        }
        const meta = await readMeta(root, fileName)
        if (tag && !meta.tags.some(t => t.toLowerCase() === tag)) continue
        if (query && !meta.title.toLowerCase().includes(query) && !meta.fileName.toLowerCase().includes(query)) continue
        entries.push(meta)
        if (entries.length >= limit) break
      }
      return {
        entries: entries.map(entry => ({
          date: entry.date,
          slug: entry.slug,
          title: entry.title,
          tags: entry.tags,
          fileName: entry.fileName,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
        })),
        total: entries.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_read',
    description: 'Read one diary entry (its frontmatter and full markdown body) by date, plus the '
      + 'optional slug used when several entries share a date.',
    parameters: {
      date: { type: 'string', required: true, description: 'Entry date as YYYY-MM-DD.' },
      slug: { type: 'string', description: 'Optional slug for a second entry on the same date.' },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const entry = await resolveEntry(root, args.date, args.slug, exec.signal)
      const slug = parseFileName(entry.fileName)!.slug
      const { meta, body } = parseDocument(entry.body)
      return {
        path: entry.path,
        date: args.date,
        slug,
        title: meta.title ?? '',
        tags: meta.tags ?? [],
        content: body,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read diary entry', kind: 'read', locations: [{ path: fileNameFor(args.date, args.slug) }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_update',
    description: 'Update an existing diary entry: replace the body, append text, or change its title '
      + 'and tags. Pass only the fields you want to change; at least one of `content`, `append`, '
      + '`title`, or `tags` is required.',
    parameters: {
      date: { type: 'string', required: true, description: 'Entry date as YYYY-MM-DD.' },
      slug: { type: 'string', description: 'Optional slug for a second entry on the same date.' },
      content: { type: 'string', description: 'Replacement markdown body (replaces the current body).' },
      append: { type: 'string', description: 'Text appended to the end of the current body.' },
      title: { type: 'string', description: 'New title; omit to keep the current title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list; omit to keep the current tags.' },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Updated diary entry ${value.path}` }],
    },
    async execute(args, exec) {
      if (args.content === undefined && args.append === undefined && args.title === undefined && args.tags === undefined) {
        throw new Error('diary_update requires at least one of content, append, title, or tags')
      }
      const entry = await resolveEntry(root, args.date, args.slug, exec.signal)
      const parsed = parseFileName(entry.fileName)!
      const { meta, body } = parseDocument(entry.body)
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
      await writeFile(entry.path, serializeDocument(nextMeta, nextBody), { encoding: 'utf8', signal: exec.signal })
      return { path: entry.path, date: args.date, slug: parsed.slug, title: nextTitle, tags: nextTags, content: nextBody }
    },
    presentCall: args => ({ card: 'generic', title: 'Update diary entry', kind: 'edit', locations: [{ path: fileNameFor(args.date, args.slug) }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_delete',
    description: 'Delete a diary entry markdown file by date (and optional slug). This permanently '
      + 'removes the file.',
    parameters: {
      date: { type: 'string', required: true, description: 'Entry date as YYYY-MM-DD.' },
      slug: { type: 'string', description: 'Optional slug for a second entry on the same date.' },
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
      render: (_args, value) => [{ type: 'text', text: `Deleted diary entry ${value.path}` }],
    },
    async execute(args, exec) {
      assertDate(args.date)
      const fileName = fileNameFor(args.date, args.slug)
      const filePath = join(root, fileName)
      try {
        await rm(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`diary entry not found: ${fileName}`)
        }
        throw error
      }
      return { deleted: true, path: filePath }
    },
    presentCall: args => ({ card: 'generic', title: 'Delete diary entry', kind: 'other', locations: [{ path: fileNameFor(args.date, args.slug) }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'diary_search',
    description: 'Full-text search across all diary entry bodies. Returns each matching file with the '
      + 'line number and the matching line (snippet).',
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
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Found ${value.total} match${value.total === 1 ? '' : 'es'} across diary entries.` }],
    },
    async execute(args) {
      const query = args.query
      if (query.trim().length === 0) {
        throw new Error('diary_search requires a non-empty query')
      }
      const limit = args.limit === undefined ? 50 : Math.max(1, Math.min(1000, Math.trunc(args.limit)))
      const files = await listDiaryFiles(root)
      const matches: Array<{ date: string; slug: string; title: string; fileName: string; lineNumber: number; snippet: string }> = []
      for (const fileName of files) {
        const parsed = parseFileName(fileName)!
        let content: string
        try {
          content = await readFile(join(root, fileName), { encoding: 'utf8' })
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
          })
          if (matches.length >= limit) break
        }
        if (matches.length >= limit) break
      }
      return { matches, total: matches.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'diary_template_list',
    description: 'List the diary templates available to `diary_create`. Templates are markdown files '
      + 'under `<diary-directory>/templates/` whose placeholders get substituted on use.',
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
    async execute() {
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
      + '`day`, `datetime`, and `time`, substituted when `diary_create` applies the template.',
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
