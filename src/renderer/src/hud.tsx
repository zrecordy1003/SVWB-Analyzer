import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import HudApp from './hudcomponents/HudApp/HudApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HudApp />
  </StrictMode>
)
