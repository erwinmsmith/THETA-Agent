import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import css from './HistoryActionDialog.module.css'

export interface HistoryActionTarget {
  kind: 'rename' | 'delete' | 'pin'
  target: 'run' | 'workspace'
  id: string
  title: string
  pinned: boolean
}

interface HistoryActionDialogProps {
  action?: HistoryActionTarget
  busy: boolean
  error?: string
  onClose: () => void
  onConfirm: (value?: string) => void
}

export const HistoryActionDialog = ({ action, busy, error, onClose, onConfirm }: HistoryActionDialogProps): React.ReactElement => {
  const { locale } = usePreferences()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const zh = locale === 'zh-CN'

  useEffect(() => {
    setName(action?.title ?? '')
    if (action?.kind === 'rename') window.setTimeout(() => inputRef.current?.select(), 0)
  }, [action])

  const title = action?.kind === 'rename'
    ? (zh ? '重命名对话' : 'Rename conversation')
    : action?.kind === 'delete'
      ? (zh ? '删除对话' : 'Delete conversation')
      : action?.pinned
        ? (zh ? '取消置顶' : 'Unpin conversation')
        : (zh ? '置顶对话' : 'Pin conversation')
  const description = action?.kind === 'delete'
    ? (zh ? '该操作会删除本地记录，完成后返回初始页。' : 'This removes the local record and returns to the start page.')
    : action?.kind === 'pin'
      ? (zh ? '置顶对话会固定显示在历史列表顶部。' : 'Pinned conversations stay at the top of history.')
      : (zh ? '输入一个便于识别的新名称。' : 'Choose a clear name for this conversation.')

  const valid = action?.kind !== 'rename' || (name.trim().length > 0 && name.trim() !== action.title)
  const deleteWarning = action?.target === 'run'
    ? (zh ? '研究 Run 的结果文件也会一并清理。此操作不可撤销。' : 'Result artifacts for this research Run are also removed. This cannot be undone.')
    : (zh ? '该对话的本地消息记录会被清理。此操作不可撤销。' : 'Local messages for this conversation are removed. This cannot be undone.')

  return (
    <Modal
      open={action != null}
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={description}
      className={css.dialog}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button>
          <Button
            variant="primary"
            className={action?.kind === 'delete' ? css.danger : undefined}
            disabled={busy || !valid}
            onClick={() => onConfirm(action?.kind === 'rename' ? name.trim() : undefined)}
          >
            {busy
              ? '…'
              : action?.kind === 'delete'
                ? (zh ? '确认删除' : 'Delete')
                : action?.kind === 'pin'
                  ? (action.pinned ? (zh ? '取消置顶' : 'Unpin') : (zh ? '确认置顶' : 'Pin'))
                  : (zh ? '保存' : 'Save')}
          </Button>
        </>
      )}
    >
      <div className={css.body}>
        {action?.kind === 'rename' ? <label className={css.field}><span>{zh ? '对话名称' : 'Conversation name'}</span><input ref={inputRef} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && valid && !busy) onConfirm(name.trim()) }} /></label> : <p className={css.itemName}>{action?.title}</p>}
        {action?.kind === 'delete' && <p className={css.warning}>{deleteWarning}</p>}
        {error && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
