import { MODULES } from '../data/modules'
import { SEED_ROWS } from '../data/seed'
import {
  appendSnapshot,
  buildChecklist,
  checksum,
  listSnapshots,
  readDatabase,
  readJson,
  restoreSnapshot,
  sampleData,
  writeJson,
  DB_DATA_KEY,
  RELEASE_RECORDS_KEY,
} from './db'
import { CURRENT_SCHEMA_VERSION, pendingMigrations, syncInspectionCheckItems } from './migrations'
import type {
  BatchEvent,
  EntryLike,
  ReleaseBatch,
  ReleaseOptions,
  RuntimeInfo,
  StepArtifact,
  StepKey,
  StepState,
  StorageAdapter,
} from './types'
import { STEP_NAMES, STEP_ORDER } from './types'

/**
 * 发布流水线引擎：与浏览器/DOM 完全解耦，Node 脚本与页面共用同一套逻辑，
 * 因此本地跑出来的发布记录可以在页面里原样回放。
 */

const DEPLOY_STATE_KEY = 'hydrology-monitor-station:deploy'

type DeployState = {
  activeVersion: string | null
  activeBatchId: string | null
  activatedAt: string | null
  history: { version: string; batchId: string; activatedAt: string }[]
}

function iso(now: () => Date): string {
  return now().toISOString()
}

function freshSteps(): Record<StepKey, StepState> {
  const entries: [StepKey, StepState][] = STEP_ORDER.map((key) => [
    key,
    {
      key,
      name: STEP_NAMES[key],
      status: 'pending',
      attempts: 0,
      logs: [],
    } satisfies StepState,
  ])
  return Object.fromEntries(entries) as unknown as Record<StepKey, StepState>
}

function loadRecords(storage: StorageAdapter): ReleaseBatch[] {
  return readJson<ReleaseBatch[]>(storage, RELEASE_RECORDS_KEY, [])
}

function saveBatch(storage: StorageAdapter, batch: ReleaseBatch): void {
  const all = loadRecords(storage).filter((item) => item.batchId !== batch.batchId)
  all.push(batch)
  // 同版本永远只有一个批次文档：重复执行覆盖同一文档，而不是追加。
  writeJson(storage, RELEASE_RECORDS_KEY, all)
}

export function listBatches(storage: StorageAdapter): ReleaseBatch[] {
  return loadRecords(storage).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export function latestBatch(storage: StorageAdapter): ReleaseBatch | null {
  const all = listBatches(storage)
  return all.length ? all[all.length - 1] : null
}

type StepContext = {
  storage: StorageAdapter
  runtime: RuntimeInfo
  options: ReleaseOptions
  batch: ReleaseBatch
  snapshotId?: string
  previousDeploy: DeployState | null
}

type StepDefinition = {
  key: StepKey
  /** 有副作用的步骤在失败重试前需要重新就位（快照复用、迁移重放、核查项重写、重新部署）。 */
  rearmOnRetry: boolean
  run(ctx: StepContext): StepArtifact
  /** 整批回退动作；必须幂等，任何异常都向上抛由回退器记录但不阻断其余回退。 */
  compensate?(ctx: StepContext): string | void
}

function readDeployState(storage: StorageAdapter): DeployState {
  return readJson<DeployState | null>(storage, DEPLOY_STATE_KEY, null) ?? {
    activeVersion: null,
    activeBatchId: null,
    activatedAt: null,
    history: [],
  }
}

function seedIfEmpty(storage: StorageAdapter): void {
  const { data } = readDatabase(storage)
  if (Object.keys(data).length === 0) {
    writeJson(storage, DB_DATA_KEY, SEED_ROWS)
  }
}

export const STEP_DEFINITIONS: StepDefinition[] = [
  {
    key: 'local-dev',
    rearmOnRetry: false,
    run: ({ runtime }) => {
      // 本地开发核对：模块元数据完整性（键唯一、流转目标合法、字段齐全）。
      const keys = new Set<string>()
      const problems: string[] = []
      for (const meta of MODULES) {
        if (keys.has(meta.key)) {
          problems.push(`模块键重复：${meta.key}`)
        }
        keys.add(meta.key)
        if (meta.fields.length === 0) {
          problems.push(`${meta.name} 字段为空`)
        }
        for (const [action, target] of Object.entries(meta.actionTargets)) {
          if (!meta.statuses.includes(target)) {
            problems.push(`${meta.name} 动作「${action}」目标状态「${target}」非法`)
          }
        }
      }
      if (MODULES.length !== 18) {
        problems.push(`业务模块数量应为 18，实际 ${MODULES.length}`)
      }
      if (problems.length) {
        throw new Error(problems.join('；'))
      }
      return { modules: MODULES.length, actions: MODULES.reduce((n, m) => n + m.actions.length, 0) }
    },
  },
  {
    key: 'dependencies',
    rearmOnRetry: false,
    run: ({ runtime }) => {
      // 依赖核对：构建期登记的关键依赖必须声明了版本。
      const missing = runtime.requiredDeps.filter((dep) => !dep.declared)
      if (missing.length) {
        throw new Error(`缺少依赖声明：${missing.map((dep) => dep.name).join('、')}`)
      }
      return {
        checked: runtime.requiredDeps.length,
        deps: runtime.requiredDeps.map((dep) => `${dep.name}@${dep.declared}`),
      }
    },
  },
  {
    key: 'build',
    rearmOnRetry: false,
    run: ({ runtime }) => {
      // 构建产物核对：版本/源码指纹/构建时间三者齐备，证明产物来自真实构建而非手改。
      if (!runtime.appVersion || !/^\d+\.\d+\.\d+/.test(runtime.appVersion)) {
        throw new Error('构建产物缺少合法版本号')
      }
      if (!/^(?:[0-9a-f]{6,}|dev[a-z0-9]{6,}|nogit[0-9a-z]{6,})$/.test(runtime.sourceHash)) {
        throw new Error('构建产物缺少源码指纹')
      }
      if (Number.isNaN(Date.parse(runtime.builtAt))) {
        throw new Error('构建产物缺少构建时间')
      }
      return {
        appVersion: runtime.appVersion,
        sourceHash: runtime.sourceHash.slice(0, 12),
        builtAt: runtime.builtAt,
      }
    },
  },
  {
    key: 'deploy-env',
    rearmOnRetry: false,
    run: ({ storage }) => {
      // 部署环境核对：持久化通道可写、目标 schema 已知。
      const probe = '__release_probe__'
      try {
        storage.setItem(probe, '1')
        const value = storage.getItem(probe)
        storage.removeItem(probe)
        if (value !== '1') {
          throw new Error('持久化通道读写不一致')
        }
      } catch (error) {
        throw new Error(`部署环境不可用：${error instanceof Error ? error.message : '未知错误'}`)
      }
      return { targetSchema: CURRENT_SCHEMA_VERSION, storage: storage.constructor.name || 'custom' }
    },
  },
  {
    key: 'db-snapshot',
    rearmOnRetry: true,
    run: ({ storage, batch, runtime, options }) => {
      seedIfEmpty(storage)
      const { data, meta } = readDatabase(storage)
      const result = appendSnapshot({
        storage,
        batchId: batch.batchId,
        appVersion: runtime.appVersion,
        schemaBefore: meta.schemaVersion,
        schemaAfter: CURRENT_SCHEMA_VERSION,
        rows: data,
        now: iso(options.now ?? (() => new Date())),
      })
      const all = listSnapshots(storage)
      return {
        snapshotId: result.id,
        reused: result.reused,
        rows: Object.values(data).reduce((n, rows) => n + rows.length, 0),
        totalSnapshots: all.length,
      }
    },
    // 快照不删不回滚：「已有快照不能丢」，回退后仍可用于审计或再次还原。
  },
  {
    key: 'db-migrate',
    rearmOnRetry: true,
    run: ({ storage, batch }) => {
      const { data, meta } = readDatabase(storage)
      const chain = pendingMigrations(meta.schemaVersion)
      const applied: string[] = []
      for (const migration of chain) {
        migration.up(data)
        applied.push(`v${migration.version} ${migration.title}`)
      }
      writeJson(storage, DB_DATA_KEY, data)
      writeJson(storage, 'hydrology-monitor-station:db-meta', {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        batchId: batch.batchId,
      })
      return {
        from: meta.schemaVersion,
        to: CURRENT_SCHEMA_VERSION,
        applied,
        modules: Object.keys(data).length,
      }
    },
    compensate: ({ storage, batch }) => {
      // 整库回退到本批次发布前快照，旧版本数据按原样恢复。
      const snap = listSnapshots(storage).find((item) => item.batchId === batch.batchId)
      if (!snap) {
        throw new Error('回退失败：找不到本批次快照')
      }
      const restored = restoreSnapshot(storage, snap.id)
      return `已还原至快照 ${snap.id}（schema v${restored.schemaVersion}）`
    },
  },
  {
    key: 'checklist',
    rearmOnRetry: true,
    run: ({ storage, batch }) => {
      const { data } = readDatabase(storage)
      const rows = buildChecklist(data)
      batch.checklist = rows
      const missing = rows.filter((row) => row.total === 0).map((row) => row.name)
      if (missing.length) {
        throw new Error(`核对清单存在空模块：${missing.join('、')}`)
      }
      return {
        modules: rows.length,
        pending: rows.reduce((n, row) => n + row.pending, 0),
        abnormal: rows.reduce((n, row) => n + row.abnormal, 0),
        todos: rows.reduce((n, row) => n + row.todos.reduce((m, todo) => m + todo.count, 0), 0),
      }
    },
  },
  {
    key: 'inspection-sync',
    rearmOnRetry: true,
    run: ({ storage, batch, runtime }) => {
      // 另一个巡检入口同步写入：发布核查项追加进「巡检记录」模块，幂等不重复。
      const { data } = readDatabase(storage)
      const result = syncInspectionCheckItems(data, batch.batchId, runtime.appVersion)
      writeJson(storage, DB_DATA_KEY, data)
      return { added: result.added, skipped: result.skipped, target: 'inspection' }
    },
    compensate: ({ storage, batch }) => {
      // 回退：移除本批次写入的核查项（按批次号精确匹配，不动人工巡检记录）。
      const { data } = readDatabase(storage)
      const rows = Array.isArray(data.inspection) ? (data.inspection as EntryLike[]) : []
      const kept = rows.filter((row) => String(row['发现问题'] ?? '') !== batch.batchId)
      const removed = rows.length - kept.length
      data.inspection = kept
      writeJson(storage, DB_DATA_KEY, data)
      return `已移除 ${removed} 条本批次核查项`
    },
  },
  {
    key: 'deploy',
    rearmOnRetry: true,
    run: ({ storage, batch, runtime }) => {
      // 原子切换：先读旧版本，再一次写入新的激活版本；失败时旧版本保持不动。
      const previous = readDeployState(storage)
      if (previous.activeVersion === runtime.appVersion && previous.activeBatchId === batch.batchId) {
        return {
          activatedVersion: runtime.appVersion,
          previousVersion: previous.activeVersion ?? '(首次部署)',
          switchedAt: previous.activatedAt ?? '',
          reused: true,
        }
      }
      const next: DeployState = {
        activeVersion: runtime.appVersion,
        activeBatchId: batch.batchId,
        activatedAt: new Date().toISOString(),
        history: [
          ...previous.history,
          { version: runtime.appVersion, batchId: batch.batchId, activatedAt: new Date().toISOString() },
        ],
      }
      writeJson(storage, DEPLOY_STATE_KEY, next)
      return {
        activatedVersion: runtime.appVersion,
        previousVersion: previous.activeVersion ?? '(首次部署)',
        switchedAt: next.activatedAt ?? '',
        reused: false,
      }
    },
    compensate: ({ storage, batch }) => {
      const current = readDeployState(storage)
      if (current.activeBatchId !== batch.batchId) {
        return '当前激活版本不属于本批次，无需切回'
      }
      // 从部署历史里找到本批次之前的最后一个版本切回去（没有就回到未部署态）。
      const idx = current.history.findIndex((h) => h.batchId === batch.batchId)
      const before = idx > 0 ? current.history[idx - 1] : null
      const restored: DeployState = {
        activeVersion: before?.version ?? null,
        activeBatchId: before?.batchId ?? null,
        activatedAt: before ? new Date().toISOString() : null,
        history: current.history.filter((h) => h.batchId !== batch.batchId),
      }
      writeJson(storage, DEPLOY_STATE_KEY, restored)
      return before ? `已切回旧版本 ${before.version}` : '已回到未部署态'
    },
  },
  {
    key: 'sample',
    rearmOnRetry: true,
    run: ({ storage, batch, options }) => {
      // 上线采样：确定性等距抽样，发布记录里的样本每次回放完全一致。
      const { data } = readDatabase(storage)
      const findings = sampleData(data, options.sampleSize ?? 3)
      batch.samples = findings
      const bad = findings.filter((item) => !item.ok)
      if (bad.length) {
        throw new Error(
          `采样核对未通过：${bad
            .slice(0, 5)
            .map((item) => `${item.moduleKey}#${item.id} ${item.problems.join('、')}`)
            .join('；')}`,
        )
      }
      const modules = new Set(findings.map((item) => item.moduleKey)).size
      return { samples: findings.length, modules, allPassed: true }
    },
  },
]

const DEFINITION_BY_KEY = new Map(STEP_DEFINITIONS.map((step) => [step.key, step]))

function pushEvent(batch: ReleaseBatch, event: Omit<BatchEvent, 'at'>, now: () => Date): void {
  batch.events.push({ at: iso(now), ...event })
}

/**
 * 执行一次发布驱动。
 * - 首次：新建批次；同版本重复执行：复用同一批次（attempt +1），从失败步骤重试。
 * - 任一步失败：已执行步骤逆序整批回退，批次状态 rolled-back，发布记录完整保留。
 */
export function driveRelease(options: ReleaseOptions): ReleaseBatch {
  const { storage, runtime } = options
  const now = options.now ?? (() => new Date())
  const batchId = `rel-${runtime.appVersion}`
  const existing = loadRecords(storage).find((item) => item.batchId === batchId)

  let batch: ReleaseBatch
  let resumeFrom: StepKey
  if (existing && existing.status === 'succeeded') {
    // 成功批次幂等返回：重复执行不产生第二个批次，也不重复写数据。
    return existing
  }
  if (existing) {
    batch = existing
    batch.attempt += 1
    resumeFrom = batch.failedAt ?? STEP_ORDER[0]
    batch.resumeFrom = resumeFrom
    batch.status = 'running'
    batch.failedAt = undefined
    batch.endedAt = undefined
    for (const key of STEP_ORDER.slice(STEP_ORDER.indexOf(resumeFrom))) {
      batch.steps[key].status = 'pending'
      batch.steps[key].error = undefined
    }
    pushEvent(batch, { kind: 'retry', step: resumeFrom, message: `第 ${batch.attempt} 次执行，从「${STEP_NAMES[resumeFrom]}」重试` }, now)
  } else {
    batch = {
      batchId,
      appVersion: runtime.appVersion,
      sourceHash: runtime.sourceHash,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      status: 'running',
      startedAt: iso(now),
      attempt: 1,
      steps: freshSteps(),
      snapshots: [],
      events: [],
    }
    resumeFrom = STEP_ORDER[0]
    pushEvent(batch, { kind: 'start', message: `发布批次 ${batchId} 开始（v${runtime.appVersion}，目标 schema v${CURRENT_SCHEMA_VERSION}）` }, now)
    saveBatch(storage, batch)
  }

  const ctx: StepContext = {
    storage,
    runtime,
    options,
    batch,
    previousDeploy: null,
  }
  ctx.previousDeploy = readDeployState(storage)

  const resumeIndex = STEP_ORDER.indexOf(resumeFrom)
  const executedThisDrive: StepKey[] = []

  const fail = (message: string): ReleaseBatch => {
    batch.status = 'rolled-back'
    batch.endedAt = iso(now)
    pushEvent(batch, { kind: 'rollback-begin', message }, now)
    // 逆序整批回退：本批次所有已成功步骤的补偿动作都要执行。
    for (const key of [...executedThisDrive].reverse()) {
      const definition = DEFINITION_BY_KEY.get(key)!
      const step = batch.steps[key]
      if (!definition.compensate) {
        step.status = 'rolled-back'
        continue
      }
      try {
        const note = definition.compensate(ctx) ?? undefined
        step.status = 'rolled-back'
        step.logs.push({ at: iso(now), level: 'warn', message: note ?? '已回退（无副作用）' })
      } catch (error) {
        step.logs.push({
          at: iso(now),
          level: 'error',
          message: `回退失败：${error instanceof Error ? error.message : '未知错误'}`,
        })
      }
    }
    pushEvent(batch, { kind: 'rollback-end', message: '整批回退完成，已有快照保留，可从失败步骤重试' }, now)
    saveBatch(storage, batch)
    return batch
  }

  for (const key of STEP_ORDER) {
    const index = STEP_ORDER.indexOf(key)
    const definition = DEFINITION_BY_KEY.get(key)!
    const step = batch.steps[key]

    if (index < resumeIndex) {
      if (!definition.rearmOnRetry) {
        // 严格「从失败步骤重试」：失败点之前的只读核对沿用历史结论，不重跑、不重复计数。
        step.status = 'kept'
        step.logs.push({ at: iso(now), level: 'info', message: '重试沿用首轮结论，未重复执行' })
        continue
      }
      // 失败点之前有副作用的步骤（快照/迁移/核查项/部署）幂等重新就位，
      // 把整批回退还原掉的状态恢复到「失败步骤即将执行」的那一刻。
      step.logs.push({ at: iso(now), level: 'info', message: '重试前重新就位（幂等重放）' })
    }

    step.status = 'running'
    step.startedAt = iso(now)
    const isRearm = index < resumeIndex && definition.rearmOnRetry
    if (!isRearm) {
      step.attempts += 1
    }
    executedThisDrive.push(key)
    try {
      if (options.injectFailureAt === key) {
        throw new Error(`演练注入：「${STEP_NAMES[key]}」步骤被强制失败`)
      }
      const artifact = definition.run(ctx)
      if (key === 'db-snapshot' && artifact.snapshotId) {
        ctx.snapshotId = String(artifact.snapshotId)
        if (!batch.snapshots.includes(ctx.snapshotId)) {
          batch.snapshots.push(ctx.snapshotId)
        }
      }
      step.status = 'ok'
      step.endedAt = iso(now)
      step.artifact = artifact
      step.logs.push({ at: iso(now), level: 'info', message: `通过：${summarize(artifact)}` })
      if (!isRearm) {
        pushEvent(batch, { kind: 'step-ok', step: key, message: `${STEP_NAMES[key]} 通过` }, now)
      }
      saveBatch(storage, batch)
    } catch (error) {
      step.status = 'failed'
      step.endedAt = iso(now)
      step.error = error instanceof Error ? error.message : String(error)
      step.logs.push({ at: iso(now), level: 'error', message: step.error })
      batch.failedAt = key
      pushEvent(batch, { kind: 'step-failed', step: key, message: `${STEP_NAMES[key]} 失败：${step.error}` }, now)
      saveBatch(storage, batch)
      return fail(`「${STEP_NAMES[key]}」失败，开始整批回退：${step.error}`)
    }
  }

  batch.status = 'succeeded'
  batch.endedAt = iso(now)
  batch.resumeFrom = undefined
  batch.failedAt = undefined
  pushEvent(batch, { kind: 'finish', message: `发布成功：${runtime.appVersion} 已激活，发布记录可回放` }, now)
  saveBatch(storage, batch)
  return batch
}

function summarize(artifact: StepArtifact): string {
  return Object.entries(artifact)
    .filter(([, value]) => typeof value !== 'object')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('，')
}

/** 可回放：把发布记录导出为 Markdown 报告（步骤、清单、采样、事件全量在内）。 */
export function exportReleaseMarkdown(batch: ReleaseBatch): string {
  const lines: string[] = []
  lines.push(`# 发布记录 ${batch.batchId}`)
  lines.push('')
  lines.push(`- 应用版本：v${batch.appVersion}`)
  lines.push(`- 源码指纹：${batch.sourceHash}`)
  lines.push(`- 目标 schema：v${batch.schemaVersion}`)
  lines.push(`- 批次状态：${batch.status}`)
  lines.push(`- 执行次数：${batch.attempt}`)
  lines.push(`- 开始时间：${batch.startedAt}`)
  if (batch.endedAt) {
    lines.push(`- 结束时间：${batch.endedAt}`)
  }
  lines.push(`- 快照：${batch.snapshots.join('、') || '无'}`)
  lines.push('')
  lines.push('## 步骤')
  lines.push('')
  lines.push('| # | 步骤 | 状态 | 尝试 | 产出/错误 |')
  lines.push('| - | --- | --- | --- | --- |')
  STEP_ORDER.forEach((key, i) => {
    const step = batch.steps[key]
    const detail = step.error ?? (step.artifact ? summarize(step.artifact) : '')
    lines.push(`| ${i + 1} | ${step.name} | ${step.status} | ${step.attempts} | ${detail.replace(/\|/g, '/')} |`)
  })
  if (batch.checklist) {
    lines.push('')
    lines.push('## 模块核对清单')
    lines.push('')
    lines.push('| 模块 | 总量 | 待处理 | 异常量 | 待办 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const row of batch.checklist) {
      const todo = row.todos.map((item) => `${item.status}×${item.count}（${item.suggest}）`).join('；') || '无'
      lines.push(`| ${row.name} | ${row.total} | ${row.pending} | ${row.abnormal} | ${todo} |`)
    }
  }
  if (batch.samples) {
    lines.push('')
    lines.push('## 上线采样')
    lines.push('')
    lines.push(`共 ${batch.samples.length} 条，全部通过：${batch.samples.every((s) => s.ok) ? '是' : '否'}`)
  }
  lines.push('')
  lines.push('## 事件')
  lines.push('')
  for (const event of batch.events) {
    lines.push(`- ${event.at} ${event.kind}${event.step ? ` [${STEP_NAMES[event.step]}]` : ''}：${event.message}`)
  }
  return lines.join('\n')
}

export function batchChecksum(batch: ReleaseBatch): string {
  return checksum({
    batchId: batch.batchId,
    appVersion: batch.appVersion,
    status: batch.status,
    snapshots: batch.snapshots,
    checklist: batch.checklist,
    samples: batch.samples,
  })
}
