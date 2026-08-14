import { createRoot } from 'react-dom/client'
import { AppRoot } from './App.tsx'
import { PreferencesProvider } from './preferences.tsx'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
createRoot(el).render(<PreferencesProvider><AppRoot /></PreferencesProvider>)
