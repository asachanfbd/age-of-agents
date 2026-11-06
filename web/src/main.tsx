import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/shadcn.css'
import './index.css'
import App from './App.tsx'
import { initThemeClassSync } from './lib/uiTheme.ts'
import { trackPointerOrigin } from './lib/pointerOrigin.ts'
import { applyPopupLayoutCssVars } from './lib/popupResize.ts'

// Keeps the shadcn/Tailwind `.dark` class in sync with the theme preference (and, for
// 'daytime', the real day/night cycle) for the lifetime of the tab — see uiTheme.ts.
initThemeClassSync()
trackPointerOrigin()

// Popups, side sheets and toasts size themselves around the status footer through these variables.
applyPopupLayoutCssVars(document.documentElement)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
