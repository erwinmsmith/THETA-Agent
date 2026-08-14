import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vendor-chunk membership adapted from the DeepSeek Harness web build
 * (apps/web/vite.config.ts, MIT). The heavy render families — math, syntax
 * highlight, markdown — change only on dependency bumps, so they stay in a
 * cached vendor chunk while workspace code rides the index chunk.
 */
const VENDOR_PACKAGES: ReadonlySet<string> = new Set([
  'katex',
  'shiki',
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'mdast-util-math',
  'micromark-core-commonmark',
  'micromark-extension-gfm',
  'micromark-extension-math',
  'micromark-factory-space',
  'micromark-util-character',
  'micromark-util-classify-character',
  'micromark-util-sanitize-uri',
  'micromark-util-symbol',
  'micromark-util-types',
])

const BOOT_GRAMMAR_FILES: readonly string[] = [
  'dist/typescript.mjs',
  'dist/shellscript.mjs',
  'dist/json.mjs',
]

const FONT_EXTENSIONS: readonly string[] = ['.woff2', '.woff', '.ttf']

function npmPackageOf(id: string): string | undefined {
  const parts = id.split('/node_modules/')
  if (parts.length === 1) return undefined
  const [first, second] = parts[parts.length - 1].split('/')
  if (first.startsWith('.')) return undefined
  if (first.startsWith('@')) return second === undefined ? undefined : `${first}/${second}`
  return first
}

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        chunkFileNames(chunk): string {
          if (chunk.name === 'index' || chunk.name === 'vendor') return 'assets/[name]-[hash].js'
          const isLangChunk = chunk.moduleIds.some(id => id.includes('/node_modules/@shikijs/langs/'))
          return isLangChunk ? 'assets/langs/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        assetFileNames(asset): string {
          const fileName = asset.names[0] ?? ''
          const isFont = FONT_EXTENSIONS.some(ext => fileName.endsWith(ext))
          return isFont ? 'assets/fonts/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
        },
        manualChunks(id: string): string | undefined {
          const pkg = npmPackageOf(id)
          if (pkg === undefined) return undefined
          if (pkg === '@shikijs/langs') {
            return BOOT_GRAMMAR_FILES.some(file => id.endsWith(`/${file}`)) ? 'vendor' : undefined
          }
          return VENDOR_PACKAGES.has(pkg) ? 'vendor' : undefined
        },
      },
    },
  },
})
