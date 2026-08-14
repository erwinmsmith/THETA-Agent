import type { WebAgentInteraction, WebRunEvent } from '../api/client.ts'
import { StateDot } from '../ui/index.ts'
import css from '../styles/app.module.css'

interface FsmReasoningTraceProps {
  interaction: WebAgentInteraction
  events?: WebRunEvent[]
}

export const FsmReasoningTrace = ({
  interaction,
  events = [],
}: FsmReasoningTraceProps): React.ReactElement => {
  const recent = events.slice(-3)
  return (
    <details className={css.fsmTrace} open={interaction.card != null}>
      <summary>
        <span className={css.fsmTraceLabel}>FSM DECISION TRACE</span>
        <span className={css.fsmTraceState}>
          <StateDot size={7} state={interaction.card != null ? 'warning' : 'ongoing'} />
          {interaction.state}
        </span>
      </summary>
      <div className={css.fsmTraceGrid}>
        <div>
          <span>OBSERVATION</span>
          <p>{interaction.reasoning.observation}</p>
        </div>
        <div>
          <span>STATE GOAL</span>
          <p>{interaction.reasoning.goal}</p>
        </div>
        <div>
          <span>DECISION</span>
          <p>{interaction.reasoning.decision}</p>
        </div>
      </div>
      <div className={css.fsmTraceMeta}>
        <span>允许工具</span>
        <code>{interaction.reasoning.allowedTools.join(' · ') || 'none'}</code>
        <span>候选迁移</span>
        <code>{interaction.reasoning.nextStates.join(' → ') || 'terminal'}</code>
      </div>
      {recent.length > 0 && (
        <div className={css.fsmTraceEvents}>
          {recent.map((event) => (
            <span key={event.id}>{event.title}</span>
          ))}
        </div>
      )}
    </details>
  )
}
