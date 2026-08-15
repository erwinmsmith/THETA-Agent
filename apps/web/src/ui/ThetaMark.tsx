import type { IconProps } from './icons/props.ts'
import css from './ThetaMark.module.css'

/** Render the image-generated THETA Agent orbital mark. */
export function ThetaMark({ size = 24, className }: IconProps) {
  return (
    <span
      className={`${css.mark} ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img className={css.light} src="/brand/theta-agent-mark-light.png" alt="" draggable="false" />
      <img className={css.dark} src="/brand/theta-agent-mark-dark.png" alt="" draggable="false" />
    </span>
  )
}
