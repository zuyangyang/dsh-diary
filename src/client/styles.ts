/**
 * The settings-section stylesheet, hand-written as a template string and
 * injected once by the plugin body: the web server serves exactly one file per
 * client plugin, so no separate CSS artifact may exist. Tokens come only from
 * the shared `--dsw-alias-*` design platform (no literal colors); class names
 * carry the `dsh_diary` prefix to stay unique in the assembled shell.
 */

/** Stable `<style>` element id (idempotent injection across HMR re-runs). */
export const STYLE_ID = 'dsh-diary-style'

/** The injected stylesheet text. */
export const cssText = `
.dsh_diary_section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dsh_diary_title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
}
.dsh_diary_subtitle {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_diary_card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_diary_field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh_diary_label {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_diary_value {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  word-break: break-all;
}
.dsh_diary_row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_diary_rowName {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh_diary_rowMeta {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh_diary_input,
.dsh_diary_textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dsh_diary_textarea {
  min-height: 120px;
  resize: vertical;
  font-family: var(--dsw-font-mono, monospace);
}
.dsh_diary_input:focus,
.dsh_diary_textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh_diary_actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh_diary_button {
  flex: none;
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsh_diary_button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh_diary_buttonPrimary {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-on-brand, #fff);
}
/* The header's "new entry" primary action: turn the fill gray on hover. */
.dsh_diary_panelHeader .dsh_diary_buttonPrimary:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
}
.dsh_diary_buttonDanger {
  color: var(--dsw-alias-label-danger, inherit);
}
.dsh_diary_error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-danger, var(--dsw-alias-border-l2));
  border-radius: 8px;
  color: var(--dsw-alias-label-danger, var(--dsw-alias-label-secondary));
  font-size: 13px;
  line-height: 20px;
}
.dsh_diary_toggle {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147482000;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 22px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
}
.dsh_diary_toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh_diary_panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 2147481900;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 340px;
  max-width: 80vw;
  padding: 12px 14px 24px;
  box-sizing: border-box;
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  overflow-y: auto;
}
.dsh_diary_panelHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh_diary_panelTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dsh_diary_month {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh_diary_monthHeader {
  margin: 8px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  text-transform: uppercase;
}
.dsh_diary_entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh_diary_entryName {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh_diary_entryName:hover {
  color: var(--dsw-alias-brand-primary);
}
.dsh_diary_entryDate {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-family: var(--dsw-font-mono, monospace);
}
.dsh_diary_entryTitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh_diary_body {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-mono, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
`

/**
 * Inject the settings-section stylesheet once (stable id; HMR-safe).
 */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.appendChild(style)
}
