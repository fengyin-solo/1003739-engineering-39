#!/usr/bin/env tsx
/**
 * 可回放的发布命令（本地开发 → 构建核对 → 快照 → 迁移 → 清单 → 巡检同步 → 部署 → 采样）。
 *
 * 用法：
 *   npm run release -- run                       正常发布
 *   npm run release -- run --fail-on sample      演练「采样」失败：整批回退并自动从失败步骤重试
 *   npm run release -- run --no-retry            失败后只回退，不自动重试
 *   npm run release -- replay <batchId>          打印批次的可回放发布记录（Markdown）
 *   npm run release -- list                      列出全部发布批次（同版本只有一条）
 *   npm run release -- reset                     清空本地发布数据库（不影响浏览器数据）
 *
 * 数据落在 frontend/.release-data/：index.json 是键索引，其余文件是各「表」，
 * 快照表只追加不删除。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { SEED_ROWS } from '../src/data/seed'
import { writeJson, DB_DATA_KEY, RELEASE_RECORDS_KEY } from '../src/release/db'
import { exportReleaseMarkdown, listBatches, STEP_DEFINITIONS } from '../src/release/pipeline'
import { runReleaseWithRetry } from '../src/release/runner'
import type { ReleaseOptions, RuntimeInfo, StepKey } from '../src/release/types'
import { STEP_NAMES, STEP_ORDER } from '../src/release/types'
import { JsonFileStorage } from './file-storage'
import { gitShortHash } from './git-hash'

const DATA_DIR = resolve(process.cwd(), '.release-data')
const REPORT_DIR = resolve(process.cwd(), '.release-reports')

function parseArgs(argv: string[]): { command: string; rest: string[] } {
  // npx/tsx 在不同调用方式下会把脚本路径带进参数，过滤掉，只认业务关键字。
  const known = ['run', 'replay', 'list', 'reset']
  const words = argv.filter((word) => !word.endsWith('.ts') && !word.includes('scripts/'))
  const first = words.find((word) => known.includes(word))
  const index = first ? words.indexOf(first) : 0
  return { command: first ?? 'run', rest: words.slice(index + 1) }
}

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}

function buildRuntime(): RuntimeInfo {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    version: string
    dependencies?: Record<string, string>
  }
  const sourceHash = gitShortHash()
  const requiredDeps = Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({
    name,
    declared: version ?? null,
  }))
  return {
    appVersion: pkg.version,
    sourceHash,
    builtAt: new Date().toISOString(),
    requiredDeps,
  }
}

function ensureSeeded(storage: JsonFileStorage): void {
  if (storage.getItem(DB_DATA_KEY) === null) {
    writeJson(storage, DB_DATA_KEY, SEED_ROWS)
  }
}

function printChecklist(batch: ReturnType<typeof runReleaseWithRetry>['batch']): void {
  if (!batch.checklist) {
    return
  }
  console.log('\n模块核对清单：')
  console.log('  模块                 总量  待处理  异常量  待办')
  for (const row of batch.checklist) {
    const todos = row.todos.map((t) => `${t.status}×${t.count}`).join('，') || '无'
    console.log(
      `  ${row.name.padEnd(12, '　')} ${String(row.total).padStart(4)}  ${String(row.pending).padStart(5)}  ${String(row.abnormal).padStart(5)}  ${todos}`,
    )
  }
}

function printSteps(batch: ReturnType<typeof runReleaseWithRetry>['batch']): void {
  console.log('\n发布步骤：')
  STEP_ORDER.forEach((key, index) => {
    const step = batch.steps[key as StepKey]
    const icon = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'rolled-back' ? '↩' : step.status === 'kept' ? '→' : '·'
    const detail = step.error ?? (step.artifact ? JSON.stringify(step.artifact) : '')
    console.log(`  ${index + 1}. ${icon} ${step.name} [${step.status}] ${detail}`)
  })
}

function writeReport(batch: ReturnType<typeof runReleaseWithRetry>['batch']): string {
  mkdirSync(REPORT_DIR, { recursive: true })
  const path = resolve(REPORT_DIR, `${batch.batchId}.md`)
  writeFileSync(path, exportReleaseMarkdown(batch))
  return path
}

function cmdRun(rest: string[]): void {
  const storage = new JsonFileStorage(DATA_DIR)
  ensureSeeded(storage)
  const failOn = flagValue(rest, '--fail-on') as StepKey | undefined
  if (failOn && !STEP_DEFINITIONS.some((step) => step.key === failOn)) {
    throw new Error(`未知步骤：${failOn}，可选 ${STEP_ORDER.join('、')}`)
  }
  const options: ReleaseOptions = {
    storage,
    runtime: buildRuntime(),
    injectFailureAt: failOn,
    autoRetry: !rest.includes('--no-retry'),
    sampleSize: Number(flagValue(rest, '--sample') ?? 3),
  }
  console.log(`发布批次开始（注入故障点：${failOn ? STEP_NAMES[failOn] : '无'}，自动重试：${options.autoRetry ? '开' : '关'}）`)
  const outcome = runReleaseWithRetry(options)
  for (const [i, phase] of outcome.phases.entries()) {
    console.log(`\n=== 第 ${i + 1} 轮：${phase.status}${phase.failedAt ? `，失败于「${STEP_NAMES[phase.failedAt]}」` : ''} ===`)
  }
  printSteps(outcome.batch)
  printChecklist(outcome.batch)
  const reportPath = writeReport(outcome.batch)
  const records = JSON.parse(storage.getItem(RELEASE_RECORDS_KEY) ?? '[]') as { batchId: string }[]
  console.log(`\n结果：${outcome.batch.status}（执行 ${outcome.batch.attempt} 次）`)
  console.log(`发布记录：${reportPath}`)
  console.log(`批次数量（同版本只保留一条）：${records.filter((r) => r.batchId === outcome.batch.batchId).length} / 共 ${records.length} 条`)
  process.exitCode = outcome.batch.status === 'succeeded' ? 0 : 1
}

function cmdReplay(rest: string[]): void {
  const storage = new JsonFileStorage(DATA_DIR)
  const id = rest[0]
  const batch = listBatches(storage).find((item) => item.batchId === id || (!id && item.status === 'succeeded'))
  if (!batch) {
    console.error(`找不到批次 ${id ?? '(最近成功批次)'}`)
    process.exitCode = 1
    return
  }
  console.log(exportReleaseMarkdown(batch))
}

function cmdList(): void {
  const storage = new JsonFileStorage(DATA_DIR)
  const batches = listBatches(storage)
  if (!batches.length) {
    console.log('暂无发布批次')
    return
  }
  for (const batch of batches) {
    console.log(
      `${batch.batchId}  v${batch.appVersion}  ${batch.status}  尝试${batch.attempt}次  ${batch.startedAt}${batch.failedAt ? `  失败于${STEP_NAMES[batch.failedAt]}` : ''}`,
    )
  }
}

function cmdReset(): void {
  const storage = new JsonFileStorage(DATA_DIR)
  storage.clear()
  console.log('本地发布数据库已清空（快照一并清除；仅影响 .release-data，不影响浏览器）')
}

const { command, rest } = parseArgs(process.argv.slice(2))
if (command === 'run') {
  cmdRun(rest)
} else if (command === 'replay') {
  cmdReplay(rest)
} else if (command === 'list') {
  cmdList()
} else if (command === 'reset') {
  cmdReset()
} else {
  console.error(`未知命令：${command}（可用：run / replay / list / reset）`)
  process.exitCode = 1
}
