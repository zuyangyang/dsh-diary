/**
 * The `diary` wire contract, shared verbatim by the Host manifest
 * (`ctx.typert.register` in typert.ts) and the client contribution
 * (`ctx.remote.$mount` in client/index.ts). The Remote namespace exposes the
 * diary directory, templates, and the entry board (list/get/create/delete) to
 * the browser.
 */
import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** The resolved diary root and its templates directory. */
export const directoryViewSchema = z.object({
  directory: z.string(),
  templatesDirectory: z.string(),
}).readonly()
export type DirectoryView = z.infer<typeof directoryViewSchema>

/** One template's metadata (no content). */
export const templateMetaSchema = z.object({
  name: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
}).readonly()
export type TemplateMeta = z.infer<typeof templateMetaSchema>

/** One template's full content. */
export const templateContentSchema = z.object({
  name: z.string(),
  content: z.string(),
}).readonly()

/** A successful template save. */
export const templateSavedSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
}).readonly()

/** A successful template delete. */
export const templateDeletedSchema = z.object({
  deleted: z.boolean(),
}).readonly()

/** One diary entry's metadata (no content). */
export const entryMetaSchema = z.object({
  date: z.string(),
  slug: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  fileName: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  /** Owner bucket id, or '' for the historical files at the diary root. */
  owner: z.string(),
  /** Owner display name shown next to the entry in the board. */
  ownerName: z.string(),
}).readonly()
export type EntryMeta = z.infer<typeof entryMetaSchema>

/** One diary entry's full content. */
export const entryContentSchema = z.object({
  date: z.string(),
  slug: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  content: z.string(),
}).readonly()
export type EntryContent = z.infer<typeof entryContentSchema>

/** Input for creating one entry. */
export const entryCreateInputSchema = z.object({
  date: z.string().optional(),
  title: z.string().optional(),
  slug: z.string().optional(),
  content: z.string().optional(),
  template: z.string().optional(),
  tags: z.array(z.string()).optional(),
})
export type EntryCreateInput = z.infer<typeof entryCreateInputSchema>

/** A successful entry creation. */
export const entryCreatedSchema = z.object({
  path: z.string(),
  date: z.string(),
  slug: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
}).readonly()
export type EntryCreated = z.infer<typeof entryCreatedSchema>

/** A successful entry delete. */
export const entryDeletedSchema = z.object({
  deleted: z.boolean(),
}).readonly()
export type EntryDeleted = z.infer<typeof entryDeletedSchema>

/** The `diary` Remote namespace's strict invocation descriptors. */
export const DIARY_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: 'dsh-diary#diary/getDirectory',
    service: 'diary',
    namespace: 'diary',
    method: 'getDirectory',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#DirectoryView', schema: directoryViewSchema },
  },
  {
    id: 'dsh-diary#diary/listTemplates',
    service: 'diary',
    namespace: 'diary',
    method: 'listTemplates',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#TemplateMeta[]', schema: z.array(templateMetaSchema) },
  },
  {
    id: 'dsh-diary#diary/getTemplate',
    service: 'diary',
    namespace: 'diary',
    method: 'getTemplate',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
    ],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#TemplateContent', schema: templateContentSchema },
  },
  {
    id: 'dsh-diary#diary/setTemplate',
    service: 'diary',
    namespace: 'diary',
    method: 'setTemplate',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
      { name: 'content', wire: 'content', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
    ],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#TemplateSaved', schema: templateSavedSchema },
  },
  {
    id: 'dsh-diary#diary/deleteTemplate',
    service: 'diary',
    namespace: 'diary',
    method: 'deleteTemplate',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
    ],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#TemplateDeleted', schema: templateDeletedSchema },
  },
  {
    id: 'dsh-diary#diary/listEntries',
    service: 'diary',
    namespace: 'diary',
    method: 'listEntries',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#EntryMeta[]', schema: z.array(entryMetaSchema) },
  },
  {
    id: 'dsh-diary#diary/getEntry',
    service: 'diary',
    namespace: 'diary',
    method: 'getEntry',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'date', wire: 'date', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
      { name: 'slug', wire: 'slug', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
      {
        name: 'owner',
        wire: 'owner',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() },
        acceptsUndefined: true,
      },
    ],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#EntryContent', schema: entryContentSchema },
  },
  {
    id: 'dsh-diary#diary/createEntry',
    service: 'diary',
    namespace: 'diary',
    method: 'createEntry',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-diary#EntryCreateInput', schema: entryCreateInputSchema } },
    ],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#EntryCreated', schema: entryCreatedSchema },
  },
  {
    id: 'dsh-diary#diary/deleteEntry',
    service: 'diary',
    namespace: 'diary',
    method: 'deleteEntry',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'date', wire: 'date', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
      { name: 'slug', wire: 'slug', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
      {
        name: 'owner',
        wire: 'owner',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() },
        acceptsUndefined: true,
      },
    ],
    result: { mode: 'strict', typeSymbol: 'dsh-diary#EntryDeleted', schema: entryDeletedSchema },
  },
]
