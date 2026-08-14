import type { IconProps } from './icons/props.ts'
import { FishLogo } from './FishLogo.tsx'
import css from './BrandWordmark.module.css'

/** Render the THETA Agent product mark used by the application shell. */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <div className={`${css.mark} ${className ?? ''}`} style={{ height: size }} aria-label="THETA Agent">
      <FishLogo size={20} />
      <span className={css.name}>THETA</span>
      <span className={css.badge}>AGENT</span>
    </div>
  )
}
