/**
 * `dsh-diary` locale namespace: settings-section copy. Chinese is the product
 * copy; English mirrors it.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '日记',
  'title': '日记',
  'subtitle': '配置日记存储目录并管理自定义模版；新建日记时可用模版占位符填充正文。',
  'directoryLabel': '日记目录',
  'templatesDirectoryLabel': '模版目录',
  'templatesTitle': '自定义模版',
  'templatesDesc': '模版是「模版目录」下的 markdown 文件；在 {{date}}、{{title}}、{{tags}}、{{slug}}、{{datetime}}、{{time}} 处填入实际值。',
  'empty': '暂无模版。',
  'newTemplate': '新建模版',
  'nameLabel': '模版名称',
  'namePlaceholder': '例如 daily',
  'contentLabel': '模版内容',
  'save': '保存',
  'edit': '编辑',
  'delete': '删除',
  'cancel': '取消',
  'confirmDelete': '删除模版 {name}？此操作不可撤销。',
  'error': '操作失败：{message}',
  'board.nav': '日记看板',
  'board.new': '新建日记',
  'board.close': '关闭',
  'board.date': '日期',
  'board.title': '标题',
  'board.template': '模版',
  'board.noTemplate': '不使用模版',
  'board.content': '内容',
  'board.save': '保存',
  'board.cancel': '取消',
  'board.delete': '删除',
  'board.loading': '加载中…',
  'board.empty': '暂无日记。',
  'board.errorEmpty': '内容不能为空。',
  'board.confirmDelete': '删除日记 {name}？此操作不可撤销。',
} satisfies Record<string, string>

/** The `dsh-diary` namespace key union. */
export type DiaryKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'Diary',
  'title': 'Diary',
  'subtitle': 'Configure the diary directory and manage custom templates used to seed new entries.',
  'directoryLabel': 'Diary directory',
  'templatesDirectoryLabel': 'Templates directory',
  'templatesTitle': 'Custom templates',
  'templatesDesc': 'Templates are markdown files under the templates directory; {{date}}, {{title}}, {{tags}}, {{slug}}, {{datetime}}, and {{time}} are filled in on use.',
  'empty': 'No templates yet.',
  'newTemplate': 'New template',
  'nameLabel': 'Template name',
  'namePlaceholder': 'e.g. daily',
  'contentLabel': 'Template content',
  'save': 'Save',
  'edit': 'Edit',
  'delete': 'Delete',
  'cancel': 'Cancel',
  'confirmDelete': 'Delete template {name}? This cannot be undone.',
  'error': 'Operation failed: {message}',
  'board.nav': 'Diary board',
  'board.new': 'New entry',
  'board.close': 'Close',
  'board.date': 'Date',
  'board.title': 'Title',
  'board.template': 'Template',
  'board.noTemplate': 'No template',
  'board.content': 'Content',
  'board.save': 'Save',
  'board.cancel': 'Cancel',
  'board.delete': 'Delete',
  'board.loading': 'Loading…',
  'board.empty': 'No entries yet.',
  'board.errorEmpty': 'Content is required.',
  'board.confirmDelete': 'Delete entry {name}? This cannot be undone.',
} satisfies Record<DiaryKey, string>

/** Locale namespace id registered under ctx.locale. */
export const NS = 'dsh-diary'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The diary settings copy. */
    [NS]: DiaryKey
  }
}
