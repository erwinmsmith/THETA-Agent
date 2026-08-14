import type { IconProps } from './icons/props.ts'

/** Render the THETA aperture: a topic orbit held together by the theta axis. */
export function ThetaMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="10.8" stroke="currentColor" strokeWidth="2.35" />
      <path d="M8.8 16h14.4" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round" />
      <circle cx="25.3" cy="9.2" r="2.15" fill="currentColor" />
      <circle cx="7.5" cy="22.5" r="1.35" fill="currentColor" opacity=".5" />
      <circle cx="20.6" cy="25.5" r="1.35" fill="currentColor" opacity=".72" />
    </svg>
  )
}
