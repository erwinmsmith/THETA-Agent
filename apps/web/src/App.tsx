/**
 * THETA Agent conversational web shell.
 *
 * Layout plan (S3/S4): session list | conversation stream | research detail
 * panel. This placeholder imports the vendored DeepSeek Harness design
 * tokens and UI primitives to prove the toolchain before the real UI lands.
 */
import './styles/base.css'
import { BrandWordmark, Button, StateDot } from './ui/index.ts'

export const AppRoot = (): React.ReactElement => {
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <BrandWordmark />
      <StateDot state="ready" />
      <Button variant="primary">THETA Agent shell ready</Button>
    </div>
  )
}
