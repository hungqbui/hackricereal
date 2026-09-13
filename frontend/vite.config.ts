import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The app talks to the FastAPI backend through /api so the browser never
// needs CORS in development. Point VITE_BACKEND_URL elsewhere if the
// backend is not on the default uvicorn port.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const backend = env.VITE_BACKEND_URL || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
