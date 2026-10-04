import { invalidateCache } from '@/data/local-store'
import {
  batchChecksum,
  exportReleaseMarkdown,
  latestBatch,
  listBatches,
} from './pipeline'
import { describeFailure, runReleaseWithRetry } from './runner'
import type {
  EntryLike,
  ReleaseBatch,
  RuntimeInfo,
  StepKey,
  StorageAdapter,
} from './types'

/**
 * 浏览器侧发布入口：持久化直接用 localStorage，和命令行用的是同一套引擎、同一批键。
 */

const browserStorage: StorageAdapter = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
}

/** 读取 Vite 构建期注入的发布清单；未注入（极少数直挂场景）时给可识别的兜底值。 */
function runtimeFromBuild(): RuntimeInfo {
  const injected = typeof __RELEASE_MANIFEST__ !== 'undefined' ? __RELEASE_MANIFEST__ : undefined
  if (injected) {
    return injected
  }
  return {
    appVersion: '0.0.0-dev',
    sourceHash: 'dev000000',
    builtAt: new Date().toISOString(),
    requiredDeps: [],
  }
}

export type BrowserReleaseResult = {
  batch: ReleaseBatch
  retried: boolean
  reportMarkdown: string
  checksum: string
}

export function runBrowserRelease(options: {
  injectFailureAt?: StepKey
  autoRetry?: boolean
  sampleSize?: number
}): BrowserReleaseResult {
  const outcome = runReleaseWithRetry({
    storage: browserStorage,
    runtime: runtimeFromBuild(),
    injectFailureAt: options.injectFailureAt,
    autoRetry: options.autoRetry ?? true,
    sampleSize: options.sampleSize ?? 3,
  })
  // 迁移可能直接改写 localStorage，业务数据层的内存缓存必须作废后重读。
  invalidateCache()
  return {
    batch: outcome.batch,
    retried: outcome.phases.length > 1,
    reportMarkdown: exportReleaseMarkdown(outcome.batch),
    checksum: batchChecksum(outcome.batch),
  }
}

export function getBatches(): ReleaseBatch[] {
  return listBatches(browserStorage)
}

export function getLatestBatch(): ReleaseBatch | null {
  return latestBatch(browserStorage)
}

export function replayLatest(): string | null {
  const batch = latestBatch(browserStorage)
  return batch ? exportReleaseMarkdown(batch) : null
}

export function downloadReport(markdown: string, batchId: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${batchId}.md`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export { describeFailure }
export type { EntryLike }
