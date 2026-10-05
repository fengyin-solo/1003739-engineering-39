// 把 TS 模块（manifest / seed）打包成 Node 可直接 require 的 CJS，供发布 CLI 复用。
// 复用仓库里已有的 esbuild（vite 依赖），不引入新依赖。
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, '.release-cache')
fs.mkdirSync(outDir, { recursive: true })

async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    logLevel: 'silent',
  })
}

async function main() {
  await bundle('src/release/manifest.ts', path.join(outDir, 'manifest.cjs'))
  await bundle('src/data/seed.ts', path.join(outDir, 'seed.cjs'))
  console.log('release bundle ready ->', path.relative(root, outDir))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
