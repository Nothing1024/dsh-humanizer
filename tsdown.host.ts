import { defineConfig } from 'tsdown'

/**
 * Node-half host plugin bundle (same shape as the vibee workspace's tsdown.host.ts). Official
 * platform packages stay external — they resolve from the dsh installation scope at runtime
 * (declared as peerDependencies) and from pinned devDependencies at typecheck/test time.
 */
export function hostBundle() {
  return defineConfig({
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    external: [
      'cordis',
      '@deepseek-ai/cordis',
      'cosmokit',
      'schemastery',
      '@deepseek-ai/schemastery',
      /^@deepseek-ai\//,
    ],
  })
}
