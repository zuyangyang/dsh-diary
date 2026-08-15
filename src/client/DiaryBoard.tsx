/**
 * The standalone diary board: a fixed right-hand panel listing entries grouped
 * by month, with a "new entry" form. Mounted through its own React root (like a
 * sidebar portal), so it lives outside the conversation. Pure presentation —
 * every business fact arrives through the injected `diary` Remote callbacks.
 */
import { useEffect, useMemo, useState } from 'react'

/** One entry as listed by the Remote. */
export interface BoardEntryMeta {
  date: string
  slug: string
  title: string
  tags: string[]
  fileName: string
  sizeBytes: number
  modifiedAt: string
}

/** One template as listed by the Remote. */
export interface BoardTemplateMeta {
  name: string
  fileName: string
  sizeBytes: number
  modifiedAt: string
}

/** Injected business face: the `diary` Remote, unwrapped into plain callbacks. */
export interface DiaryBoardInjected {
  listEntries: () => Promise<BoardEntryMeta[]>
  getEntry: (date: string, slug: string) => Promise<{ date: string; slug: string; title: string; tags: string[]; content: string }>
  createEntry: (input: { date?: string; title?: string; content?: string }) => Promise<void>
  deleteEntry: (date: string, slug: string) => Promise<void>
  listTemplates: () => Promise<BoardTemplateMeta[]>
  getTemplate: (name: string) => Promise<string>
}

export type DiaryBoardProps = DiaryBoardInjected & {
  t: (key: string, params?: Record<string, string>) => string
}

/** Today's local date as `YYYY-MM-DD`. */
function todayIso(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Group `YYYY-MM-DD` into its `YYYY-MM` month key. */
const monthOf = (date: string): string => date.slice(0, 7)

/**
 * Render a template's `{{name}}` placeholders against the form's date/title.
 * Mirrors the host renderer for the placeholders the board form can fill
 * (tags and slug are absent here and render empty); `{{datetime}}`/`{{time}}`
 * use the process clock, which is fine for the live form (never replay).
 */
function renderTemplate(source: string, vars: { date: string; title: string }): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const [year, month, day] = vars.date.split('-')
  const replacements: Record<string, string> = {
    date: vars.date,
    title: vars.title,
    tags: '',
    slug: '',
    year: year ?? '',
    month: month ?? '',
    day: day ?? '',
    datetime: now.toISOString(),
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  }
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => replacements[key] ?? whole)
}

/** Render the board: a toggle button plus the (conditionally open) panel. */
export function DiaryBoard({ listEntries, getEntry, createEntry, deleteEntry, listTemplates, getTemplate, t }: DiaryBoardProps) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<BoardEntryMeta[]>([])
  const [templates, setTemplates] = useState<BoardTemplateMeta[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Form state.
  const [showForm, setShowForm] = useState(false)
  const [formDate, setFormDate] = useState(todayIso())
  const [formTitle, setFormTitle] = useState('')
  const [formTemplate, setFormTemplate] = useState('')
  const [formContent, setFormContent] = useState('')

  // Open-entry state (which entry's body is expanded).
  const [openKey, setOpenKey] = useState('')
  const [openBody, setOpenBody] = useState<{ title: string; content: string } | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const [rows, tpls] = await Promise.all([listEntries(), listTemplates()])
      setEntries(rows)
      setTemplates(tpls)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const months = useMemo(() => {
    const groups = new Map<string, BoardEntryMeta[]>()
    for (const entry of entries) {
      const key = monthOf(entry.date)
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [entry])
      else list.push(entry)
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [entries])

  /** Fill the content field from one template, rendering its placeholders. */
  const applyTemplate = async (name: string, date: string, title: string): Promise<void> => {
    if (name === '') {
      setFormContent('')
      return
    }
    try {
      const source = await getTemplate(name)
      setFormContent(renderTemplate(source, { date, title }))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Open the "new entry" form, defaulting the template to the first one. */
  const openForm = async (): Promise<void> => {
    const date = todayIso()
    setFormDate(date)
    setFormTitle('')
    setError('')
    if (templates.length > 0) {
      const first = templates[0].name
      setFormTemplate(first)
      await applyTemplate(first, date, '')
    } else {
      setFormTemplate('')
      setFormContent('')
    }
    setShowForm(true)
  }

  const toggleEntry = async (entry: BoardEntryMeta): Promise<void> => {
    const key = `${entry.date}|${entry.slug}`
    if (openKey === key) {
      setOpenKey('')
      setOpenBody(null)
      return
    }
    try {
      const body = await getEntry(entry.date, entry.slug)
      setOpenKey(key)
      setOpenBody({ title: body.title, content: body.content })
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const submit = async (): Promise<void> => {
    if (formContent.trim().length === 0) {
      setError(t('board.errorEmpty'))
      return
    }
    setLoading(true)
    try {
      await createEntry({
        date: formDate.trim() || undefined,
        title: formTitle.trim() || undefined,
        content: formContent,
      })
      setShowForm(false)
      setFormTitle('')
      setFormTemplate('')
      setFormContent('')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const remove = async (entry: BoardEntryMeta): Promise<void> => {
    if (!window.confirm(t('board.confirmDelete', { name: entry.title || entry.date }))) return
    try {
      await deleteEntry(entry.date, entry.slug)
      if (openKey === `${entry.date}|${entry.slug}`) {
        setOpenKey('')
        setOpenBody(null)
      }
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const entryLabel = (entry: BoardEntryMeta): string => entry.title || entry.slug || entry.date

  return (
    <>
      <button
        type="button"
        className="dsh_diary_toggle"
        aria-label={t('board.nav')}
        title={t('board.nav')}
        onClick={() => setOpen(value => !value)}
      >
        📓
      </button>
      {open && (
        <aside className="dsh_diary_panel" aria-label={t('board.nav')}>
          <header className="dsh_diary_panelHeader">
            <span className="dsh_diary_panelTitle">{t('board.nav')}</span>
            <div className="dsh_diary_actions">
              <button type="button" className="dsh_diary_button dsh_diary_buttonPrimary" disabled={loading} onClick={() => { void openForm() }}>
                {t('board.new')}
              </button>
              <button type="button" className="dsh_diary_button" onClick={() => setOpen(false)}>{t('board.close')}</button>
            </div>
          </header>

          {error !== '' && <p className="dsh_diary_error">{error}</p>}

          {showForm && (
            <div className="dsh_diary_card">
              <div className="dsh_diary_field">
                <span className="dsh_diary_label">{t('board.date')}</span>
                <input type="date" className="dsh_diary_input" value={formDate} onChange={event => setFormDate(event.target.value)} />
              </div>
              <div className="dsh_diary_field">
                <span className="dsh_diary_label">{t('board.title')}</span>
                <input type="text" className="dsh_diary_input" value={formTitle} onChange={event => setFormTitle(event.target.value)} />
              </div>
              {templates.length > 0 && (
                <div className="dsh_diary_field">
                  <span className="dsh_diary_label">{t('board.template')}</span>
                  <select
                    className="dsh_diary_input"
                    value={formTemplate}
                    onChange={event => {
                      const name = event.target.value
                      setFormTemplate(name)
                      void applyTemplate(name, formDate, formTitle)
                    }}
                  >
                    <option value="">{t('board.noTemplate')}</option>
                    {templates.map(template => <option key={template.name} value={template.name}>{template.name}</option>)}
                  </select>
                </div>
              )}
              <div className="dsh_diary_field">
                <span className="dsh_diary_label">{t('board.content')}</span>
                <textarea className="dsh_diary_textarea" value={formContent} onChange={event => setFormContent(event.target.value)} />
              </div>
              <div className="dsh_diary_actions">
                <button type="button" className="dsh_diary_button dsh_diary_buttonPrimary" disabled={loading} onClick={() => { void submit() }}>
                  {t('board.save')}
                </button>
                <button type="button" className="dsh_diary_button" onClick={() => setShowForm(false)}>{t('board.cancel')}</button>
              </div>
            </div>
          )}

          {loading && entries.length === 0 && <p className="dsh_diary_subtitle">{t('board.loading')}</p>}
          {!loading && entries.length === 0 && <p className="dsh_diary_subtitle">{t('board.empty')}</p>}

          {months.map(([month, monthEntries]) => (
            <section key={month} className="dsh_diary_month">
              <h3 className="dsh_diary_monthHeader">{month}</h3>
              {monthEntries.map(entry => (
                <div key={`${entry.date}|${entry.slug}`} className="dsh_diary_entry">
                  <div className="dsh_diary_row">
                    <button type="button" className="dsh_diary_entryName" onClick={() => { void toggleEntry(entry) }}>
                      <span className="dsh_diary_entryDate">{entry.date.slice(5)}</span>
                      <span className="dsh_diary_entryTitle">{entryLabel(entry)}</span>
                    </button>
                    <button type="button" className="dsh_diary_button dsh_diary_buttonDanger" disabled={loading} onClick={() => { void remove(entry) }}>
                      {t('board.delete')}
                    </button>
                  </div>
                  {openKey === `${entry.date}|${entry.slug}` && openBody !== null && (
                    <pre className="dsh_diary_body">{openBody.content}</pre>
                  )}
                </div>
              ))}
            </section>
          ))}
        </aside>
      )}
    </>
  )
}
