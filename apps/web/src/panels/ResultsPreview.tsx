import type { WebAttachment, WebRunResults } from '../api/client.ts'
import { resultArchiveUrl, resultAssetUrl } from '../api/client.ts'
import { Button } from '../ui/index.ts'
import { usePreferences } from '../preferences.tsx'
import css from '../styles/app.module.css'

interface ResultsPreviewProps {
  runId: string
  results?: WebRunResults
  onAttach: (attachment: WebAttachment) => void
}

export const ResultsPreview = ({ runId, results, onAttach }: ResultsPreviewProps): React.ReactElement => {
  const { locale, t } = usePreferences()
  if (!results || (results.visualizations.length === 0 && results.topics.length === 0)) {
    return <div className={css.empty}>{locale === 'zh-CN' ? '训练完成后，图、表和指标会在这里出现。' : 'Charts, tables, and metrics appear here after training.'}</div>
  }

  const drag = (event: React.DragEvent, attachment: WebAttachment): void => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-theta-artifact', JSON.stringify(attachment))
  }

  return (
    <div className={css.resultsPreview}>
      <div className={css.resultsSummary}>
        <div><strong>{results.researchStatus ?? results.status}</strong><span>{results.message}</span></div>
        <a className={css.archiveButton} href={resultArchiveUrl(runId)}>{t('download')} ↓</a>
      </div>
      {results.visualizations.map((visualization) => {
        const attachment: WebAttachment = { kind: 'visualization', id: visualization.id, label: visualization.label }
        return (
          <article
            key={visualization.id}
            className={css.visualizationCard}
            draggable
            onDragStart={(event) => drag(event, attachment)}
          >
            {visualization.format === 'image'
              ? <img src={resultAssetUrl(runId, visualization.relativePath)} alt={visualization.label} loading="lazy" />
              : <iframe src={resultAssetUrl(runId, visualization.relativePath)} title={visualization.label} sandbox="allow-scripts" />}
            <div>
              <strong>{visualization.label}</strong>
              <Button size="sm" variant="ghost" onClick={() => onAttach(attachment)}>{t('attach')}</Button>
            </div>
          </article>
        )
      })}
      {results.topics.length > 0 && (
        <article
          className={css.topicTable}
          draggable
          onDragStart={(event) => drag(event, { kind: 'table', id: 'topic-table', label: locale === 'zh-CN' ? '主题表' : 'Topic table' })}
        >
          <div className={css.topicTableHead}>
            <strong>{locale === 'zh-CN' ? '主题表' : 'Topic table'}</strong>
            <Button size="sm" variant="ghost" onClick={() => onAttach({ kind: 'table', id: 'topic-table', label: locale === 'zh-CN' ? '主题表' : 'Topic table' })}>{t('attach')}</Button>
          </div>
          <div className={css.topicRows}>
            {results.topics.slice(0, 12).map((topic) => (
              <button key={topic.id} type="button" onClick={() => onAttach({ kind: 'topic', id: topic.id, label: topic.name })}>
                <span>{topic.id}</span><strong>{topic.name}</strong><small>{topic.keywords.slice(0, 5).join(' · ')}</small>
              </button>
            ))}
          </div>
        </article>
      )}
      {Object.keys(results.metrics).length > 0 && (
        <div className={css.metricGrid}>
          {Object.entries(results.metrics).slice(0, 12).map(([key, value]) => (
            <button key={key} type="button" onClick={() => onAttach({ kind: 'metric', id: key, label: key })}>
              <span>{key}</span><strong>{typeof value === 'number' ? value.toFixed(3) : String(value)}</strong>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
