import type { UserConfig } from 'tsdown'
import { hostBundle } from '../../tsdown.host.ts'

const PLUGIN_ID = 'dsh-tool-humanize'

/** Module specifiers the dsh web shell shares with plugin bundles (see vibee's ui-vibee). */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom']

/**
 * Browser half: one CJS closure registered through window.__ModuleLoader__ (the dsh web module
 * loader), the same envelope ui-vibee and the official client plugins ship. CSS is a string in
 * styles.ts, so no CSS pipeline is needed.
 */
const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  minify: (process.env.NODE_ENV ?? 'production') === 'production',
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [{ ...hostBundle(), clean: false }, client]
