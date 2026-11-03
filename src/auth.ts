/**
 * The authorization seam between the diary and the optional dsh-family-auth
 * sibling plugin.
 *
 * A diary is the most private thing this plugin stores, so every read and every
 * write goes through a view built from the execution that asked for it. The view
 * answers two questions — which owner buckets may this execution see, and whose
 * bucket a new entry goes into — and it owns the on-disk layout, because here the
 * layout *is* the permission boundary:
 *
 *   root/<ownerId>/YYYY-MM-DD[-slug].md   one member's entries
 *   root/_pending/YYYY-MM-DD[-slug].md    entries written before anyone was identified
 *   root/YYYY-MM-DD[-slug].md             the historical single-user layout
 *
 * Nothing here imports dsh-family-auth: the service is optional and reached
 * through the structural {@link FamilyAuth} interface, exactly like every other
 * business plugin that listens on `ctx.inject(['familyAuth'], …)`.
 *
 * The one rule this module exists to enforce: a guard that cannot answer fails
 * closed. It never degrades into "show everything", because that failure is
 * silent and hands one household member another's diary.
 * @module dsh-diary/auth
 */

import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/** Module name this plugin registers with dsh-family-auth. */
export const AUTH_MODULE = 'diary'

/** Directory under the diary root holding entries written anonymously. */
export const PENDING_DIR = '_pending'

/** Label for the historical entries that sit directly under the diary root. */
const LEGACY_LABEL = '旧日记'

/**
 * The member dsh-family-auth resolved for one execution.
 *
 * Only the fields the diary needs; the sibling plugin owns the rest.
 */
export interface DiaryActor {
  readonly id: string
  readonly name: string
  readonly role: 'owner' | 'member'
}

/**
 * The DSH tool execution a guard reads identity from.
 *
 * dsh-family-auth derives the session from `agent.session.id`; the web panel
 * methods have no execution at all, which is exactly why the README documents
 * that the panel cannot resolve an actor.
 */
export interface DiaryExec {
  readonly signal?: AbortSignal
  readonly agent?: { readonly session?: { readonly id?: string } }
}

/**
 * The subset of dsh-family-auth's public service the diary consumes.
 *
 * Structural, so an older or newer sibling version still fits as long as these
 * methods exist. `defineModule` is optional and probed with `typeof`.
 */
export interface FamilyAuth {
  defineModule?(definition: { name: string; title?: string }): unknown
  actorOf(exec: DiaryExec | undefined): DiaryActor | null
  mustWrite(exec: DiaryExec | undefined, module: string): { ownerId: string; anonymous?: boolean }
  readScope(exec: DiaryExec | undefined, module: string): Set<string> | null
  mustAccess(exec: DiaryExec | undefined, module: string, action: 'read' | 'write' | 'manage', resource: { ownerId: string }): unknown
  ownerLabel(ownerId: string | null | undefined): string
  findMember(name: string): { id: string; name: string } | null | undefined
  record?(exec: DiaryExec | undefined, module: string, action: string, decision: unknown, resource?: unknown): unknown
}

/** The deployment knobs the auth view reads. `Config` in index.ts is assignable. */
export interface DiaryAuthConfig {
  /** Resolved diary root directory. */
  directory: string
  /** `single` makes the service optional; `auth` requires it (and refuses when absent). */
  identity: 'single' | 'auth'
  /** Owner id that names the shared pending bucket (usually `default`). */
  fallbackOwner: string
}

/** One directory of diary files, identified by the owner it belongs to. */
export interface DiaryBucket {
  /** Owner id; the empty string is the historical root bucket. */
  id: string
  /** Absolute directory holding this bucket's entry files. */
  root: string
  /** Owner display name, or 未识别 / 旧日记 for the shared buckets. */
  label: string
  /** True for the pending bucket and the historical files at the root. */
  pending: boolean
}

/** Optional logger the fail-closed path reports through. */
export interface DiaryLogger {
  warn?(message: string): void
}

/** Input of {@link createAuthView}. */
export interface CreateAuthViewInput {
  /** dsh-family-auth's service, or null when the sibling plugin is absent. */
  auth: FamilyAuth | null
  /** Deployment config (directory, identity mode, fallback owner). */
  config: DiaryAuthConfig
  /** The tool execution this view answers for; the web panel has none. */
  exec?: DiaryExec | undefined
  /** Alias for {@link CreateAuthViewInput.exec}. */
  actor?: DiaryExec | undefined
  /** Logger for the fail-closed read-scope path. */
  logger?: DiaryLogger | undefined
}

/**
 * Owner ids double as directory names, so they must be a single safe segment.
 * A value that fails this check never becomes a path; the read/write it belongs
 * to fails instead of guessing at a sanitized name that could collide.
 */
export function isUsableOwnerId(ownerId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(ownerId)
    && ownerId !== '.'
    && ownerId !== '..'
    && ownerId !== PENDING_DIR
    && ownerId !== 'templates'
}

/** Directory name for one owner id, refusing anything that is not one segment. */
function ownerDirName(ownerId: string): string {
  if (!isUsableOwnerId(ownerId)) {
    throw new Error('日记：家庭成员 id ' + JSON.stringify(ownerId) + ' 不能用作目录名')
  }
  return ownerId
}

/** A message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The scoped view one tool execution (or the web panel) uses for every read and
 * write. Build it once per call; the read scope is resolved at most once.
 */
export class DiaryAuthView {
  private readonly auth: FamilyAuth | null
  private readonly config: DiaryAuthConfig
  private readonly exec: DiaryExec | undefined
  private readonly logger: DiaryLogger | undefined

  private scopeResolved = false
  private visibleScope: Set<string> | null = null
  private actorResolved = false
  private resolvedActor: DiaryActor | null = null

  constructor(input: CreateAuthViewInput) {
    this.auth = input.auth
    this.config = input.config
    this.exec = input.exec ?? input.actor
    this.logger = input.logger
  }

  /** True when dsh-family-auth drives identity. */
  get authActive(): boolean {
    return this.auth !== null
  }

  /** Owner id the shared pending bucket is recorded under. */
  get pendingOwnerId(): string {
    return this.config.fallbackOwner
  }

  /** Resolved diary root directory. */
  get directory(): string {
    return this.config.directory
  }

  /**
   * Refuse when the deployment declared `identity: 'auth'` but the sibling
   * plugin never loaded. Falling back to the unfiltered single-user layout here
   * would be the exact silent downgrade the configuration asked to avoid, so
   * every tool calls this before touching disk.
   * @throws {Error} when auth is configured and missing.
   */
  ensureReady(): void {
    if (this.auth === null && this.config.identity === 'auth') {
      throw new Error('家庭权限未就绪：identity 配置为 auth，但 dsh-family-auth 没有加载；'
        + '请在 profile 里启用 dsh-family-auth，或者把 identity 改回 single')
    }
  }

  /** The member this execution speaks for, or null for an unidentified conversation. */
  actor(): DiaryActor | null {
    if (this.actorResolved) return this.resolvedActor
    this.actorResolved = true
    if (this.auth === null) return null
    try {
      this.resolvedActor = this.auth.actorOf(this.exec) ?? null
    } catch {
      // Identity that cannot be resolved is no identity; the guards below turn
      // that into a refusal rather than a default.
      this.resolvedActor = null
    }
    return this.resolvedActor
  }

  /** Whether the caller is the household owner (true in single-user mode). */
  isOwner(): boolean {
    if (this.auth === null) return true
    return this.actor()?.role === 'owner'
  }

  /**
   * Owner ids this execution may read; `null` means unrestricted (the household
   * owner). A throwing guard yields the empty set, never `null`.
   */
  scope(): Set<string> | null {
    if (this.scopeResolved) return this.visibleScope
    this.scopeResolved = true
    const auth = this.auth
    if (auth === null) {
      this.visibleScope = null
      return null
    }
    try {
      const scope = auth.readScope(this.exec, AUTH_MODULE)
      this.visibleScope = scope === null || scope === undefined ? null : new Set(scope)
    } catch (error) {
      this.visibleScope = new Set()
      this.logger?.warn?.('日记：读取范围不可用，本次只返回空结果（' + messageOf(error) + '）')
    }
    return this.visibleScope
  }

  /** The bucket its owner id names; `''` is the historical root bucket. */
  bucketFor(ownerId: string): DiaryBucket {
    if (ownerId === '') {
      // The historical root files are only "pending" once auth is active: in
      // single-user mode the root *is* the one person's diary, not a bucket.
      return { id: '', root: this.config.directory, label: this.label(''), pending: this.auth !== null }
    }
    if (ownerId === this.pendingOwnerId) {
      return { id: ownerId, root: join(this.config.directory, PENDING_DIR), label: this.label(ownerId), pending: true }
    }
    return { id: ownerId, root: join(this.config.directory, ownerDirName(ownerId)), label: this.label(ownerId), pending: false }
  }

  /** Owner display label; the pending and historical buckets get their own copy. */
  label(ownerId: string): string {
    if (ownerId === '') return this.auth === null ? '' : LEGACY_LABEL
    if (this.auth === null) return ownerId
    try {
      const label = this.auth.ownerLabel(ownerId)
      return typeof label === 'string' && label.length > 0 ? label : ownerId
    } catch {
      return ownerId
    }
  }

  /**
   * The bucket a new entry is written to.
   *
   * In single-user mode that is the historical root layout, unchanged. With
   * dsh-family-auth the guard names the owner; an unidentified conversation
   * lands in the shared pending bucket, which the household owner can claim.
   */
  writeBucket(): DiaryBucket {
    this.ensureReady()
    const auth = this.auth
    if (auth === null) return this.bucketFor('')
    const stamp = auth.mustWrite(this.exec, AUTH_MODULE)
    if (stamp.anonymous === true || stamp.ownerId === this.pendingOwnerId) {
      return this.bucketFor(this.pendingOwnerId)
    }
    return this.bucketFor(stamp.ownerId)
  }

  /**
   * Every bucket this execution may read, in a deterministic order: the
   * historical root files and the pending bucket first, then member directories
   * sorted by id. An unrestricted scope (the household owner) sees all of them;
   * a bound member sees only the owner ids in scope, and never the pending
   * bucket — see the comment below for why that narrows dsh-family-auth's
   * fallback-owner rule.
   */
  async readBuckets(): Promise<DiaryBucket[]> {
    this.ensureReady()
    if (this.auth === null) return [this.bucketFor('')]
    const scope = this.scope()
    if (scope === null) {
      const buckets: DiaryBucket[] = [this.bucketFor(''), this.bucketFor(this.pendingOwnerId)]
      for (const ownerId of await this.memberDirIds()) buckets.push(this.bucketFor(ownerId))
      return buckets
    }
    // dsh-family-auth puts its fallbackOwner in every member's scope, because
    // that bucket is shared household state in its own model. A diary is not
    // shared: an unclaimed entry stays readable by the household owner and by
    // the unidentified conversation that wrote it, and by nobody else until
    // diary_claim hands it to a member. So a bound member's scope never opens
    // the pending bucket here.
    const includePending = this.actor() === null
    const buckets: DiaryBucket[] = []
    for (const ownerId of scope) {
      if (ownerId === '') continue
      if (ownerId === this.pendingOwnerId && !includePending) continue
      if (!isUsableOwnerId(ownerId)) {
        this.logger?.warn?.('日记：读取范围里有一个不能用作目录名的 owner id，已跳过：' + JSON.stringify(ownerId))
        continue
      }
      buckets.push(this.bucketFor(ownerId))
    }
    return buckets
  }

  /**
   * Buckets the web panel shows. The panel is the operator's console and has no
   * execution, so this deliberately ignores the per-member read scope; the
   * README documents that limitation instead of pretending otherwise.
   * @param mode - all member directories, or just the pending buckets.
   */
  async consoleBuckets(mode: 'all' | 'pending'): Promise<DiaryBucket[]> {
    if (mode === 'pending') return [this.bucketFor(''), this.bucketFor(this.pendingOwnerId)]
    if (this.auth === null) return [this.bucketFor('')]
    const buckets: DiaryBucket[] = [this.bucketFor(''), this.bucketFor(this.pendingOwnerId)]
    for (const ownerId of await this.memberDirIds()) buckets.push(this.bucketFor(ownerId))
    return buckets
  }

  /** Bucket a panel-created entry is written to: the pending bucket under auth. */
  consoleWriteBucket(): DiaryBucket {
    return this.authActive ? this.bucketFor(this.pendingOwnerId) : this.bucketFor('')
  }

  /** The two buckets `diary_claim` reads from: the historical root files and pending. */
  claimBuckets(): DiaryBucket[] {
    return [this.bucketFor(''), this.bucketFor(this.pendingOwnerId)]
  }

  /**
   * Guard a write to one existing bucket.
   *
   * The pending bucket is shared, so it follows the same rule `mustWrite`
   * applies to creates: an unidentified conversation may write it, and a
   * member cannot (that is the whole point of "pending"). The historical root
   * files are stronger: only the household owner may touch them, because they
   * predate any member and may hold entries from everyone.
   * @param bucket - bucket the write targets.
   * @throws {Error} when the caller may not write there.
   */
  assertWrite(bucket: DiaryBucket): void {
    this.ensureReady()
    const auth = this.auth
    if (auth === null) return
    if (bucket.id === this.pendingOwnerId) {
      if (this.actor() === null) return
      auth.mustAccess(this.exec, AUTH_MODULE, 'write', { ownerId: this.pendingOwnerId })
      return
    }
    if (bucket.id === '') {
      auth.mustAccess(this.exec, AUTH_MODULE, 'manage', { ownerId: this.pendingOwnerId })
      return
    }
    auth.mustAccess(this.exec, AUTH_MODULE, 'write', { ownerId: bucket.id })
  }

  /**
   * Guard a write to household-shared state (the templates directory).
   * Templates are not personal entries, so any identified writer may edit them;
   * the check exists so `identity: 'auth'` still refuses when the service is
   * missing and so unbound conversations follow the same fallback rule.
   */
  assertSharedWrite(): void {
    this.ensureReady()
    const auth = this.auth
    if (auth === null) return
    auth.mustWrite(this.exec, AUTH_MODULE)
  }

  /** Resolve one bucket from a member name, an owner id, or an owner label. */
  async bucketByToken(token: string): Promise<DiaryBucket | null> {
    const wanted = token.trim()
    if (wanted.length === 0) return null
    const buckets = await this.readBuckets()
    const direct = buckets.find(bucket => bucket.id === wanted || bucket.label === wanted)
    if (direct !== undefined) return direct
    const member = this.findMember(wanted)
    if (member === null) return null
    return buckets.find(bucket => bucket.id === member.id) ?? null
  }

  /** Look up an active member by display name, or null. */
  findMember(name: string): { id: string; name: string } | null {
    const auth = this.auth
    if (auth === null || typeof auth.findMember !== 'function') return null
    try {
      const member = auth.findMember(name)
      return member === null || member === undefined ? null : { id: member.id, name: member.name }
    } catch {
      return null
    }
  }

  /** Append an authorization decision to dsh-family-auth's audit table, when it audits. */
  record(action: string, decision: { allow: boolean; reason: string }, resource?: { ownerId: string }): void {
    const auth = this.auth
    if (auth === null || typeof auth.record !== 'function') return
    try {
      auth.record(this.exec, AUTH_MODULE, action, decision, resource)
    } catch {
      // An audit failure must not turn a completed write into an error.
    }
  }

  /** Member directory names on disk, sorted; the pending and template dirs excluded. */
  private async memberDirIds(): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.config.directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter(entry => entry.isDirectory() && entry.name !== 'templates' && isUsableOwnerId(entry.name))
      .map(entry => entry.name)
      .sort()
  }
}

/**
 * Build the scoped view for one tool execution (or for the web panel, which has
 * no execution and therefore no actor).
 * @param input - service, deployment config, execution, logger.
 * @returns the view every read and write in this plugin goes through.
 */
export function createAuthView(input: CreateAuthViewInput): DiaryAuthView {
  return new DiaryAuthView(input)
}
