import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { initMotion } from './lib/motion'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

// Registers the GSAP React plugin and wires the reduced-motion listener
// before the first render, so no animation plays at full length in a
// reduced-motion session.
initMotion()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
