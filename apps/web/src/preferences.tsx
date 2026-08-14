import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type AppLocale = 'zh-CN' | 'en'
export type AppTheme = 'light' | 'dark' | 'system'

const copy = {
  'zh-CN': {
    newChat: '新建对话', history: '历史记录', emptyHistory: '还没有研究记录。',
    welcome: '你想用 THETA 研究什么？', placeholder: '说说你想研究的问题…',
    send: '发送', queued: '已排队', processing: '正在处理', you: '你', agent: 'THETA Agent',
    howStart: '怎么开始？', capabilities: '你可以做什么？', modelAdvice: '如何选择主题模型？',
    analyzeData: '帮我分析一份文本数据', rename: '重命名', delete: '删除', cancel: '取消', save: '保存',
    results: '结果', status: '状态', activity: '活动', memory: '记忆', download: '打包下载',
    attach: '添加到对话', accept: '接受', reject: '拒绝', reason: '输入原因或修改意见（可选）',
    addData: '添加数据', chooseFiles: '拖入文件，或选择文件/文件夹',
    run: '开始研究', light: '浅色', dark: '深色', inspect: '查看运行详情',
  },
  en: {
    newChat: 'New conversation', history: 'History', emptyHistory: 'No research history yet.',
    welcome: 'What would you like to research with THETA?', placeholder: 'Describe what you want to investigate…',
    send: 'Send', queued: 'Queued', processing: 'Working', you: 'You', agent: 'THETA Agent',
    howStart: 'How do I start?', capabilities: 'What can you do?', modelAdvice: 'How do I choose a topic model?',
    analyzeData: 'Help me analyze a text dataset', rename: 'Rename', delete: 'Delete', cancel: 'Cancel', save: 'Save',
    results: 'Results', status: 'Status', activity: 'Activity', memory: 'Memory', download: 'Download archive',
    attach: 'Attach to chat', accept: 'Accept', reject: 'Reject', reason: 'Reason or correction (optional)',
    addData: 'Add data', chooseFiles: 'Drop files, or choose a file/folder', run: 'Start research',
    light: 'Light', dark: 'Dark', inspect: 'Inspect run details',
  },
} as const

type CopyKey = keyof typeof copy['zh-CN']

interface PreferencesValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
  theme: AppTheme
  setTheme: (theme: AppTheme) => void
  resolvedTheme: 'light' | 'dark'
  toggleTheme: () => void
  t: (key: CopyKey) => string
}

const PreferencesContext = createContext<PreferencesValue | null>(null)

export const PreferencesProvider = ({ children }: { children: ReactNode }): React.ReactElement => {
  const [locale, setLocale] = useState<AppLocale>(() =>
    localStorage.getItem('theta.locale') === 'en' ? 'en' : 'zh-CN')
  const [theme, setTheme] = useState<AppTheme>(() => {
    const stored = localStorage.getItem('theta.theme')
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const change = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', resolvedTheme === 'dark')
    document.documentElement.dataset.theme = resolvedTheme
    localStorage.setItem('theta.theme', theme)
  }, [resolvedTheme, theme])

  useEffect(() => {
    document.documentElement.lang = locale
    localStorage.setItem('theta.locale', locale)
  }, [locale])

  const value = useMemo<PreferencesValue>(() => ({
    locale,
    setLocale,
    theme,
    setTheme,
    resolvedTheme,
    toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
    t: (key) => copy[locale][key],
  }), [locale, theme, resolvedTheme])

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export const usePreferences = (): PreferencesValue => {
  const value = useContext(PreferencesContext)
  if (!value) throw new Error('usePreferences must be used within PreferencesProvider.')
  return value
}
