import './assets/main.css'

import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import HudApp from './hudcomponents/HudApp/HudApp'

class HudErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[HUD render failed]', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            margin: 8,
            padding: 12,
            border: '1px solid rgba(242, 140, 140, 0.55)',
            borderRadius: 10,
            background: 'rgba(34, 20, 25, 0.96)',
            color: '#f6d7d7',
            fontFamily: 'Segoe UI, sans-serif',
            fontSize: 12
          }}
        >
          HUD 無法載入。請重啟應用程式。
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HudErrorBoundary>
      <HudApp />
    </HudErrorBoundary>
  </StrictMode>
)
