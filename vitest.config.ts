import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  resolve: {
    dedupe: ['cordis', '@deepseek-ai/cordis'],
    alias: [
      { find: /^dsh-tool-humanize$/, replacement: fileURLToPath(new URL('./packages/tool-humanize/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
  },
})
