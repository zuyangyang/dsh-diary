/**
 * The settings-page section for the `dsh-diary` namespace: shows the resolved
 * diary directory and manages the custom templates (list, create, edit, delete)
 * through the injected `diary` Remote callbacks. Pure presentation: every
 * business fact arrives through the inject face; no ctx, no subscriptions.
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** One template as listed by the Remote. */
export interface TemplateRow {
  name: string
  fileName: string
  sizeBytes: number
  modifiedAt: string
}

/** Injected business face: the `diary` Remote, unwrapped into plain callbacks. */
export interface DiarySectionInjected {
  getDirectory: () => Promise<{ directory: string; templatesDirectory: string }>
  listTemplates: () => Promise<TemplateRow[]>
  getTemplate: (name: string) => Promise<string>
  setTemplate: (name: string, content: string) => Promise<void>
  deleteTemplate: (name: string) => Promise<void>
}

/** Full section props: runtime share + injected face + the locale seat. */
export type DiarySectionProps = PropsRuntime<'settings.section'> & InjectFace<DiarySectionInjected> & PropsLocale<'dsh-diary'>

/**
 * Render the section: directory display plus the template manager.
 * @param props - the injected callbacks and the locale translator `t`.
 * @returns the section element tree.
 */
export function DiarySection({ getDirectory, listTemplates, getTemplate, setTemplate, deleteTemplate, t }: DiarySectionProps) {
  const [directory, setDirectory] = useState('')
  const [templatesDirectory, setTemplatesDirectory] = useState('')
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [error, setError] = useState('')

  // Editor state: `editing` names the template being edited ('' = new).
  const [editing, setEditing] = useState('')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const [dir, rows] = await Promise.all([getDirectory(), listTemplates()])
      setDirectory(dir.directory)
      setTemplatesDirectory(dir.templatesDirectory)
      setTemplates(rows)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const startNew = (): void => {
    setEditing('')
    setName('')
    setContent('')
  }

  const startEdit = async (templateName: string): Promise<void> => {
    try {
      const text = await getTemplate(templateName)
      setEditing(templateName)
      setName(templateName)
      setContent(text)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError(t('error', { message: t('nameLabel') }))
      return
    }
    setBusy(true)
    try {
      await setTemplate(trimmed, content)
      await load()
      setEditing(trimmed)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (templateName: string): Promise<void> => {
    if (!window.confirm(t('confirmDelete', { name: templateName }))) return
    setBusy(true)
    try {
      await deleteTemplate(templateName)
      if (editing === templateName) startNew()
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const formatBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

  return (
    <section className="dsh_diary_section" aria-labelledby="dsh-diary-settings-title">
      <h2 id="dsh-diary-settings-title" className="dsh_diary_title">{t('title')}</h2>
      <p className="dsh_diary_subtitle">{t('subtitle')}</p>

      <div className="dsh_diary_card">
        <div className="dsh_diary_field">
          <span className="dsh_diary_label">{t('directoryLabel')}</span>
          <span className="dsh_diary_value">{directory}</span>
        </div>
        <div className="dsh_diary_field">
          <span className="dsh_diary_label">{t('templatesDirectoryLabel')}</span>
          <span className="dsh_diary_value">{templatesDirectory}</span>
        </div>
      </div>

      {error !== '' && <p className="dsh_diary_error">{error}</p>}

      <div className="dsh_diary_field">
        <span className="dsh_diary_label">{t('templatesTitle')}</span>
        <p className="dsh_diary_subtitle">{t('templatesDesc')}</p>
        {templates.length === 0
          ? <p className="dsh_diary_subtitle">{t('empty')}</p>
          : templates.map(template => (
            <div key={template.name} className="dsh_diary_row">
              <span className="dsh_diary_rowName">{template.name}</span>
              <span className="dsh_diary_rowMeta">{formatBytes(template.sizeBytes)}</span>
              <div className="dsh_diary_actions">
                <button type="button" className="dsh_diary_button" disabled={busy} onClick={() => { void startEdit(template.name) }}>
                  {t('edit')}
                </button>
                <button type="button" className="dsh_diary_button dsh_diary_buttonDanger" disabled={busy} onClick={() => { void remove(template.name) }}>
                  {t('delete')}
                </button>
              </div>
            </div>
          ))}
      </div>

      <div className="dsh_diary_card">
        <div className="dsh_diary_field">
          <span className="dsh_diary_label">{editing === '' ? t('newTemplate') : `${t('edit')} — ${editing}`}</span>
          <input
            type="text"
            className="dsh_diary_input"
            placeholder={t('namePlaceholder')}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </div>
        <div className="dsh_diary_field">
          <span className="dsh_diary_label">{t('contentLabel')}</span>
          <textarea
            className="dsh_diary_textarea"
            value={content}
            onChange={event => setContent(event.target.value)}
          />
        </div>
        <div className="dsh_diary_actions">
          <button type="button" className="dsh_diary_button dsh_diary_buttonPrimary" disabled={busy} onClick={() => { void save() }}>
            {t('save')}
          </button>
          <button type="button" className="dsh_diary_button" disabled={busy} onClick={startNew}>
            {t('cancel')}
          </button>
        </div>
      </div>
    </section>
  )
}
