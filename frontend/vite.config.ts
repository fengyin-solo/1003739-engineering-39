import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { gitShortHash } from './scripts/git-hash'

type ReleaseManifest = {
  appVersion: string
  sourceHash: string
  builtAt: string
  requiredDeps: { name: string; declared: string | null }[]
}

// 构建/启动时生成发布运行时清单并通过 define 注入：
// 发布流水线的「构建产物核对」步骤靠它确认产物版本、源码指纹与构建时间可溯源。
function releaseManifestPlugin(): Plugin {
  return {
    name: 'hydrology-release-manifest',
    config() {
      const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
        version: string
        dependencies?: Record<string, string>
      }
      const sourceHash = gitShortHash()
      const manifest: ReleaseManifest = {
        appVersion: pkg.version,
        sourceHash,
        builtAt: new Date().toISOString(),
        requiredDeps: Object.entries(pkg.dependencies ?? {}).map(([name, declared]) => ({
          name,
          declared: declared ?? null,
        })),
      }
      return {
        define: {
          __RELEASE_MANIFEST__: JSON.stringify(manifest),
        },
      }
    },
  }
}

// 纯前端应用：没有后端，也就没有 /api 代理，业务数据走 src/api/local-service.ts，
// 发布流水线走 src/release/，两边的持久化键完全一致，浏览器与 CLI 可互相回放。
export default defineConfig({
  plugins: [vue(), releaseManifestPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 关掉自动打开页面：起服务时只打印地址，不拉起浏览器
    open: false,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
