/**
 * The hand-written Host Typert manifest for the `diary` Remote. Registered
 * through `ctx.typert.register` in the plugin body, it claims the wire
 * endpoints through the strict registry — the same path generated `./typert`
 * artifacts use — so the Host Gateway resolves and invokes `diary/*` without
 * consulting the `@Remote` marker table (which can split across source-launch
 * and profile-loaded bundles).
 */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { DIARY_INVOCATIONS } from './contract.ts'

/** The `diary` namespace's host manifest (strict codecs shared with the client). */
export const TYPERT_MANIFEST: TypertContribution = {
  package: 'dsh-diary',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'diary',
        exportName: 'DiaryRuntime',
        description: 'Diary directory, templates, and the entry board for the web settings section.',
        tags: [],
        members: [
          { kind: 'method', name: 'getDirectory', signature: 'getDirectory(): Promise<DirectoryView>' },
          { kind: 'method', name: 'listTemplates', signature: 'listTemplates(): Promise<readonly TemplateMeta[]>' },
          { kind: 'method', name: 'getTemplate', signature: 'getTemplate(name: string): Promise<TemplateContent>' },
          { kind: 'method', name: 'setTemplate', signature: 'setTemplate(name: string, content: string): Promise<TemplateSaved>' },
          { kind: 'method', name: 'deleteTemplate', signature: 'deleteTemplate(name: string): Promise<TemplateDeleted>' },
          { kind: 'method', name: 'listEntries', signature: 'listEntries(): Promise<readonly EntryMeta[]>' },
          { kind: 'method', name: 'getEntry', signature: 'getEntry(date: string, slug: string): Promise<EntryContent>' },
          { kind: 'method', name: 'createEntry', signature: 'createEntry(input: EntryCreateInput): Promise<EntryCreated>' },
          { kind: 'method', name: 'deleteEntry', signature: 'deleteEntry(date: string, slug: string): Promise<EntryDeleted>' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: DIARY_INVOCATIONS,
}
