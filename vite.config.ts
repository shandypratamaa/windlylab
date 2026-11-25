import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project sites live below /<repository>/. Locally the app uses /.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const repository = env.GITHUB_REPOSITORY?.split('/')[1]
const base = env.VITE_BASE_PATH ?? (env.GITHUB_ACTIONS && repository ? `/${repository}/` : '/')

const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

export default defineConfig({
  base,
  plugins: [react()],
  // Cross-origin isolation enables SharedArrayBuffer, which the solver uses to run on several cores.
  server: {
    headers: isolation,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  preview: { headers: isolation },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
                    if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) return 'runtime'
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) return 'react'
        },
      },
    },
  },
})
