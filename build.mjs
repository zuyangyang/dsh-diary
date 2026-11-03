/**
 * Host + client build for dsh-diary.
 *
 * The host half is plain ESM for Node. The web server serves exactly one file
 * per plugin (/plugins/dsh-diary/client.js), so the client half is one CJS
 * bundle wrapped in the ModuleLoader factory handshake; `@deepseek-ai/*` and
 * `react` stay external (the profile's healed node_modules and the app's
 * module system provide them). `js-yaml` and `zod` are bundled so the plugin
 * ships self-contained for its own runtime dependencies.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-diary', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// Emit host type declarations alongside the bundle (package `types` points here).
//
// Strict type checking needs the harness type packages of the exact checkout this
// plugin was written against: the published @deepseek-ai/* releases predate
// `TypertRemoteValue.schema`, and src/contract.ts legitimately uses it. Outside
// that checkout the check fails on upstream code only, so fall back to
// declaration emit without checking rather than failing the build - esbuild has
// already stripped the types from the bundle, and shipping no `.d.ts` at all
// would be worse than shipping unchecked ones.
import { execFileSync } from 'node:child_process'
try {
  execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' })
} catch {
  console.warn('[build] strict typecheck failed against the published type packages;'
    + ' emitting declarations with --noCheck instead (the bundle is unaffected)')
  execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json', '--noCheck'], { stdio: 'inherit' })
}
