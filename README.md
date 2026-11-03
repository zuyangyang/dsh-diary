# dsh-diary

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a
daily markdown journal: create entries, manage the resulting `.md` files, use custom templates, and
configure it all from a web settings section.

## What it adds

Eleven model-facing tools, registered on `ctx.tools`:

| Tool | Purpose |
|---|---|
| `diary_create` | Create a new entry (`YYYY-MM-DD[-slug].md`) with optional title, tags, body, and a named template |
| `diary_list` | List entries with metadata, filterable by year/month, tag, or title/filename substring |
| `diary_read` | Read one entry's frontmatter and full body |
| `diary_update` | Replace or append the body, and/or change the title and tags |
| `diary_delete` | Delete one entry file |
| `diary_search` | Full-text search across entry bodies with line numbers and snippets |
| `diary_claim` | Household owner only: hand a pending (unclaimed) entry to a member by moving its file |
| `diary_template_list` | List the templates available to `diary_create` |
| `diary_template_read` | Read one template's full content |
| `diary_template_set` | Create or overwrite a template |
| `diary_template_delete` | Delete a template |

## Custom templates

Templates are markdown files under `<diary-directory>/templates/`. `diary_create` accepts a
`template` name and substitutes these placeholders in the template body:

`{{date}}` `{{title}}` `{{tags}}` `{{slug}}` `{{year}}` `{{month}}` `{{day}}` `{{datetime}}` `{{time}}`

When both `template` and `content` are given to `diary_create`, the rendered template body comes
first and `content` is appended after a blank line.

## Web GUI

The plugin ships a browser half (`lib/client.js`, served at `/plugins/dsh-diary/client.js`) with two
surfaces:

- a **「日记」settings section**: shows the diary/templates directory and lists, creates, edits, and
  deletes templates;
- a **日记看板 (diary board)**: a standalone panel (its own floating toggle button, 📓) that lists
  entries **grouped by month**, with a **「新建日记」** button and a per-entry delete action.

Both are backed by a `diary` Typert Remote namespace exposed under `/api/diary/*`:
`getDirectory`, `listTemplates`, `getTemplate`, `setTemplate`, `deleteTemplate`, `listEntries`,
`getEntry`, `createEntry`, `deleteEntry`.

## Storage

Entries are markdown files with optional YAML frontmatter:

```markdown
---
title: My day
date: 2026-08-14
tags:
  - work
  - life
---

Today I …
```

By default they live under `$DSH_HOME/diaries` (falling back to `~/.dsh/diaries`). Override the
directory in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-diary
      name: 'dsh-diary'
      config:
        directory: '/Users/me/Diary'
```

One entry per date is the default; pass a `slug` to `diary_create` to keep several entries on the
same day (the file becomes `YYYY-MM-DD-<slug>.md`).

## Family diaries with dsh-family-auth

[dsh-family-auth](https://github.com/zuyangyang/dsh-family-auth) is an optional sibling plugin. When
the profile loads it, the diary becomes per-member:

```yaml
- insert:
    - id: dsh-diary
      name: 'dsh-diary'
      config:
        directory: '/Users/me/Diary'
        identity: 'auth'        # 'single' (default) only makes the plugin optional
        fallbackOwner: 'default' # owner id of the shared pending bucket
        panel: 'all'             # 'all' (default) | 'pending' | 'off'
```

`identity` decides whether the sibling plugin is **required**, not whether it is used: whenever
dsh-family-auth is loaded the diary is per-member; `single` (the default) means "run fine without
it" (the historical shared layout), while `auth` means "refuse every tool with a clear error when
the service is missing".

### Layout

```text
<directory>/<ownerId>/YYYY-MM-DD[-slug].md   one member's entries
<directory>/_pending/YYYY-MM-DD[-slug].md    entries written before anyone was identified
<directory>/YYYY-MM-DD[-slug].md             the historical single-user layout
<directory>/templates/                       diary templates, shared by the household
```

Reads are limited to the owner ids `auth.readScope(exec, 'diary')` returns; a guard that cannot
answer produces an empty scope, never an unfiltered one. Two members may journal the same date:
`diary_list` / `diary_search` label every row with its owner, and `diary_read` / `diary_update` /
`diary_delete` refuse an ambiguous date unless you pass `owner`.

The shared pending bucket is readable by the household owner and by the unidentified conversation
that wrote it. It is deliberately **not** readable by ordinary members (dsh-family-auth's
fallbackOwner is normally visible to the whole household; a diary is private enough to narrow that):
a member sees an entry only after the owner claims it for them.

Files that were already directly under `<directory>` before auth was enabled are treated as
unclaimed: the household owner can read and claim them, members never see them, and nothing is
migrated silently.

### Claiming pending entries

```text
diary_claim({ member: '小明' })                    # move every pending entry to 小明
diary_claim({ member: '小明', date: '2026-11-03' }) # just that day
diary_claim({ member: '小明', dry_run: true })      # preview, change nothing
```

The claim is a real file move between owner directories (there is no side table to rewrite), only
the household owner may run it (`role: 'owner'`), and a destination that already exists is reported
as skipped instead of overwritten.

### Web board

The browser board and settings section talk to a Typert Remote, which carries **no tool execution**
and therefore cannot resolve an actor. That is an acknowledged limitation, not isolation:

- `panel: 'all'` (default) is the operator's console: it lists every member's entries and labels each
  entry with its owner, and entries created from the board land in the **pending** bucket until the
  owner claims them;
- `panel: 'pending'` shows only the pending bucket (and the historical root files);
- `panel: 'off'` refuses every entry method of the panel.

Template management keeps working in every panel mode; templates are household-shared.

## Install

Install the published [`dsh-diary`](https://www.npmjs.com/package/dsh-diary) package into the web
profile:

```sh
dsh plugin --profile web add dsh-diary
```

Then restart the web server for the new layer (tools + settings section) to take effect.

## Develop

```sh
npm install       # links/installs @deepseek-ai/* host + client packages
npm run build     # esbuild → lib/index.js (host) + lib/client.js (browser) + declarations
npm run typecheck
node smoke.mjs    # functional smoke test of the eleven tools, plus a pending-claim round trip
npm test          # node --test test/auth.test.js: per-member isolation, pending bucket, claim
```
