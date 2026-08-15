# dsh-diary

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a
daily markdown journal: create entries, manage the resulting `.md` files, use custom templates, and
configure it all from a web settings section.

## What it adds

Ten model-facing tools, registered on `ctx.tools`:

| Tool | Purpose |
|---|---|
| `diary_create` | Create a new entry (`YYYY-MM-DD[-slug].md`) with optional title, tags, body, and a named template |
| `diary_list` | List entries with metadata, filterable by year/month, tag, or title/filename substring |
| `diary_read` | Read one entry's frontmatter and full body |
| `diary_update` | Replace or append the body, and/or change the title and tags |
| `diary_delete` | Delete one entry file |
| `diary_search` | Full-text search across entry bodies with line numbers and snippets |
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

## Install

Install the published [`dsh-diary`](https://www.npmjs.com/package/dsh-diary) package into the web
profile:

```sh
dsh plugin --profile web add dsh-diary
```

Then restart the web server for the new layer (tools + settings section) to take effect.

## Develop

```sh
pnpm install      # links @deepseek-ai/* host + client packages for typecheck
pnpm run build    # esbuild → lib/index.js (host) + lib/client.js (browser) + declarations
pnpm run typecheck
node smoke.mjs    # functional smoke test of the ten tools
```
