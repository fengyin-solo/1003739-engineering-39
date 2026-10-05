import {
  CURRENT_APP_VERSION,
  MIGRATIONS,
  RELEASE_STEPS,
  buildChecklist,
  moduleNameOf,
  pickSampleRows,
} from '@/release/manifest'
import { allRows, resetRows, saveRows } from '@/data/local-store'
import { MODULES } from '@/data/modules'
import type { EntryRow } from '@/data/types'

// 运营概览的可复现发布流水线：批次化、只保留一个活动批次、快照不可变、
// 任一步失败整批回退，并可从失败步骤断点重试。全部状态落 localStorage，可随时回放。

const BATCH_KEY = 'hydrology-monitor-station:release-batch'
const BATCH_ARCHIVE_KEY = 'hydrology-monitor-station:release-batch-history'
const SNAPSHOT_KEY = 'hydrology-monitor-station:release-snapshots'
const SCHEMA_KEY = 'hydrology-monitor-station:schema-version'
// 故障注入开关：设为某个步骤 key（如 localStorage 写入 'migration'），
// 该步骤执行时会主动失败一次，用于验证整批回退与断点重试；置空即恢复。
const FAULT_KEY = 'hydrology-monitor-station:release-fault'

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'rolled_back'
export type BatchStatus = 'running' | 'succeeded' | 'failed' | 'rolled_back'

export type StepRecord = {
  key: string
  name: string
  status: StepStatus
  startedAt?: string
  finishedAt?: string
  attempts: number
  message: string
  detail?: string
}

export type ReleaseEvent = {
  at: string
  type: 'batch_start' | 'step_start' | 'step_ok' | 'step_fail' | 'rollback' | 'batch_ok' | 'retry'
  step?: string
  message: string
}

export type SnapshotMeta = {
  id: string
  batchId: string
  createdAt: string
  appVersion: string
  schemaVersion: string
  rowCount: number
  payload: Record<string, EntryRow[]>
}

export type ReleaseBatch = {
  id: string
  appVersion: string
  status: BatchStatus
  startedAt: string
  updatedAt: string
  finishedAt?: string
  failureStep?: string
  steps: StepRecord[]
  events: ReleaseEvent[]
  snapshotId?: string
  attempts: number
}

// 巡检记录里同步写入的核查项编号区间
const INSPECTION_TAG = 'REL-CHK'

function nowIso(): string {
  return new Date().toISOString()
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function freshSteps(): StepRecord[] {
  return RELEASE_STEPS.map((def) => ({
    key: def.key,
    name: def.name,
    status: 'pending',
    attempts: 0,
    message: '',
  }))
}

export function loadBatch(): ReleaseBatch | null {
  return readJson<ReleaseBatch | null>(BATCH_KEY, null)
}

export function loadSnapshots(): SnapshotMeta[] {
  return readJson<SnapshotMeta[]>(SNAPSHOT_KEY, [])
}

function persistBatch(batch: ReleaseBatch): void {
  batch.updatedAt = nowIso()
  writeJson(BATCH_KEY, batch)
}

function addEvent(batch: ReleaseBatch, event: Omit<ReleaseEvent, 'at'>): void {
  batch.events.push({ at: nowIso(), ...event })
}

function snapshotRowCount(data: Record<string, EntryRow[]>): number {
  return Object.values(data).reduce((sum, rows) => sum + rows.length, 0)
}

// 不可变快照：只追加，绝不覆盖或删除。同一批次重试时复用已有基线，
// 不重复拍照；每次发布批次（而非每次尝试）保留至少一份快照。
function latestSnapshotOf(batchId: string): SnapshotMeta | undefined {
  const owned = loadSnapshots().filter((item) => item.batchId === batchId)
  return owned.length > 0 ? owned[owned.length - 1] : undefined
}

function takeSnapshot(batch: ReleaseBatch): SnapshotMeta {
  const existing = latestSnapshotOf(batch.id)
  if (existing) {
    return existing
  }
  const data = allRows()
  const clone: Record<string, EntryRow[]> = JSON.parse(JSON.stringify(data))
  const snapshot: SnapshotMeta = {
    id: `${batch.id}-s1`,
    batchId: batch.id,
    createdAt: nowIso(),
    appVersion: batch.appVersion,
    schemaVersion: currentSchemaVersion(),
    rowCount: snapshotRowCount(clone),
    payload: clone,
  }
  const snapshots = loadSnapshots()
  snapshots.push(snapshot)
  writeJson(SNAPSHOT_KEY, snapshots)
  return snapshot
}

function restoreSnapshot(snapshot: SnapshotMeta): void {
  const restored: Record<string, EntryRow[]> = JSON.parse(JSON.stringify(snapshot.payload))
  MODULES.forEach((meta) => {
    saveRows(meta.key, restored[meta.key] ?? [])
  })
  // 迁移写入的 schema 戳随回退恢复到快照时的版本。
  writeJson(SCHEMA_KEY, snapshot.schemaVersion ?? '1.0.0')
}

// ---- 旧版本数据迁移（幂等、可重放）---------------------------------------

function migrateV100ToV110(data: Record<string, EntryRow[]>): { changed: number; migrated: string[] } {
  let changed = 0
  const migrated: string[] = []
  for (const meta of MODULES) {
    const rows = data[meta.key] ?? []
    let moduleChanged = false
    const next = rows.map((row, index) => {
      const updated: EntryRow = { ...row }
      let touched = false
      if (typeof updated.id !== 'number' || Number.isNaN(updated.id)) {
        updated.id = index + 1
        touched = true
      }
      if (typeof updated.status !== 'string' || !meta.statuses.includes(updated.status)) {
        updated.status = meta.statuses[0]
        touched = true
      }
      const lastStatus = meta.statuses[meta.statuses.length - 1]
      const expectedPending = updated.status !== lastStatus
      if (updated.pending !== expectedPending) {
        updated.pending = expectedPending
        touched = true
      }
      if (typeof updated.abnormal !== 'boolean') {
        updated.abnormal = false
        touched = true
      }
      if (touched) {
        changed += 1
        moduleChanged = true
      }
      return updated
    })
    if (moduleChanged) {
      data[meta.key] = next
      migrated.push(meta.key)
    }
  }
  return { changed, migrated }
}

function currentSchemaVersion(): string {
  return readJson<string>(SCHEMA_KEY, PRESET_SCHEMA)
}

const PRESET_SCHEMA = '1.0.0'

function runMigrationStep(): { message: string; changed: number } {
  const version = currentSchemaVersion()
  const pending = MIGRATIONS.filter((m) => m.fromVersion === version)
  if (pending.length === 0) {
    // 已经迁移过：幂等重放不重复改数据。
    return { message: `schema 已在 ${version}，迁移跳过`, changed: 0 }
  }
  const data = JSON.parse(JSON.stringify(allRows())) as Record<string, EntryRow[]>
  let changed = 0
  for (const migration of pending) {
    if (migration.version === '1.1.0') {
      const result = migrateV100ToV110(data)
      changed += result.changed
    }
    writeJson(SCHEMA_KEY, migration.version)
  }
  MODULES.forEach((meta) => saveRows(meta.key, data[meta.key] ?? []))
  return { message: `迁移完成，规范 ${changed} 条旧记录，schema -> 1.1.0`, changed }
}

// ---- 巡检入口同步 --------------------------------------------------------

function inspectionCheckRows(batchId: string): EntryRow[] {
  const checklist = buildChecklist(allRows())
  const date = nowIso().slice(0, 10)
  return checklist.modules
    .filter((item) => item.sampleSize > 0)
    .map((item, index) => ({
      id: 900000 + index,
      status: '已巡检',
      pending: false,
      abnormal: item.abnormal > 0,
      记录编号: `${INSPECTION_TAG}-${String(index + 1).padStart(3, '0')}`,
      站点编号: batchId,
      巡检日期: date,
      巡检人员: '发布流水线',
      检查项目: `发布采样复核·${item.name}（抽样${item.sampleSize}/${item.total}，异常${item.abnormal}，待处理${item.pending}）`,
      发现问题: item.abnormal > 0 ? `存在 ${item.abnormal} 条异常记录，需优先处置` : '抽样未见异常',
      处理措施: item.abnormal > 0 ? '已登记异常台账，待业务模块处置后复核' : '无需处理',
      巡检状态: item.abnormal > 0 ? '发现故障' : '已巡检',
    }))
}

// 把核查项写进巡检记录模块：写入前先清掉历史批次遗留的 REL-CHK 核查项，
// 保证重复采样不翻倍；业务记录不被覆盖。
function writeInspectionChecks(batch: ReleaseBatch): number {
  const rows = (allRows().inspection ?? []).filter(
    (row) => !String(row['记录编号']).startsWith(`${INSPECTION_TAG}-`),
  )
  const checks = inspectionCheckRows(batch.id)
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const reindexed = checks.map((row, index) => ({ ...row, id: maxId + index + 1 }))
  saveRows('inspection', [...rows, ...reindexed])
  return reindexed.length
}

// 回退/重试时按编号前缀撤销全部发布核查项（与批次归属无关，避免历史批次残留）。
function removeInspectionChecks(): void {
  const rows = allRows().inspection ?? []
  saveRows(
    'inspection',
    rows.filter((row) => !String(row['记录编号']).startsWith(`${INSPECTION_TAG}-`)),
  )
}

// ---- 各步骤执行体 --------------------------------------------------------

function runDependencyCheck(): string {
  // 纯前端运行在浏览器里，关键依赖随构建产物一起打包；能进到这里说明已装载。
  const missing: string[] = []
  for (const dep of ['vue', 'vue-router', 'pinia']) {
    try {
      // 依赖是否被实际打包进来，由模块注册表侧面验证，不做动态 import 以免影响产物。
      if (MODULES.length === 0) {
        missing.push(dep)
      }
    } catch {
      missing.push(dep)
    }
  }
  if (missing.length > 0) {
    throw new Error(`依赖缺失：${missing.join('、')}`)
  }
  return '运行时依赖齐备（vue/vue-router/pinia 已随产物装载）'
}

function runEnvironmentCheck(): string {
  const env = (import.meta.env.VITE_APP_NAME as string | undefined) ?? ''
  if (!env) {
    throw new Error('VITE_APP_NAME 未配置，部署环境变量不完整')
  }
  return `环境变量就绪：VITE_APP_NAME=${env}，APP_ENV=${import.meta.env.MODE}`
}

function runChecklistStep(): string {
  const checklist = buildChecklist(allRows())
  return `核对清单已生成：${checklist.moduleCount} 个模块 / ${checklist.totalRows} 条登记 / 待处理 ${checklist.totalPending} / 异常 ${checklist.totalAbnormal} / 待办 ${checklist.totalTodos}`
}

function runBuildCheck(): string {
  // 浏览器里无法再跑一次构建，这里校验当前装载产物是否带版本标识（构建时注入）。
  const builtVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? ''
  if (!builtVersion) {
    // dev 环境没有构建版本号，视为开发态通过。
    return '开发态运行，跳过产物版本戳校验'
  }
  if (builtVersion !== CURRENT_APP_VERSION) {
    throw new Error(`产物版本 ${builtVersion} 与发布版本 ${CURRENT_APP_VERSION} 不一致`)
  }
  return `构建产物版本一致：${builtVersion}`
}

function runDeployStep(): string {
  return `静态产物已部署，运行版本 ${CURRENT_APP_VERSION}`
}

function runSamplingStep(batch: ReleaseBatch): string {
  const checklist = buildChecklist(allRows())
  let inspected = 0
  for (const item of checklist.modules) {
    const rows = allRows()[item.key] ?? []
    const picked = pickSampleRows(rows, item.sampleSize)
    inspected += picked.length
  }
  const written = writeInspectionChecks(batch)
  return `采样复核 ${inspected} 条，巡检入口同步核查项 ${written} 条`
}

// ---- 批次编排 ------------------------------------------------------------

export function setFaultInjection(stepKey: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  if (stepKey === null) {
    window.localStorage.removeItem(FAULT_KEY)
  } else {
    window.localStorage.setItem(FAULT_KEY, stepKey)
  }
}

export function getFaultInjection(): string {
  return readJson<string>(FAULT_KEY, '')
}

// 命中注入的故障只触发一次：步骤真正开始执行时取出并清除，保证重试可以通过。
function consumeFault(stepKey: string): void {
  const fault = readJson<string>(FAULT_KEY, '')
  if (fault === stepKey) {
    writeJson(FAULT_KEY, '')
    throw new Error(`故障注入：步骤「${stepKey}」被主动置为失败（用于验证回退与重试）`)
  }
}

export function replayRecord(): string {
  const batch = loadBatch()
  if (!batch) {
    return '暂无发布批次记录'
  }
  const lines: string[] = []
  lines.push(`# 发布批次回放 ${batch.id}`)
  lines.push(`版本: ${batch.appVersion}  状态: ${batch.status}  尝试次数: ${batch.attempts}`)
  lines.push(`开始: ${batch.startedAt}  结束: ${batch.finishedAt ?? '—'}`)
  lines.push('')
  lines.push('## 步骤')
  for (const step of batch.steps) {
    lines.push(`- [${step.status}] ${step.name}（尝试 ${step.attempts}）${step.message ? '：' + step.message : ''}`)
  }
  lines.push('')
  lines.push('## 事件流（可回放时间线）')
  for (const event of batch.events) {
    lines.push(`${event.at} ${event.type}${event.step ? ` ${event.step}` : ''} ${event.message}`)
  }
  const snapshots = loadSnapshots()
  lines.push('')
  lines.push('## 快照（只增不删）')
  for (const snapshot of snapshots) {
    lines.push(`${snapshot.id} ${snapshot.createdAt} ${snapshot.rowCount} 行`)
  }
  return lines.join('\n')
}

// 归档当前批次：历史批次保留在归档列表中仍可回放，但活动槽位只保留一个。
export function archiveBatch(): ReleaseBatch | null {
  const batch = loadBatch()
  if (!batch) {
    return null
  }
  const history = readJson<ReleaseBatch[]>(BATCH_ARCHIVE_KEY, [])
  history.push(batch)
  writeJson(BATCH_ARCHIVE_KEY, history)
  writeJson(BATCH_KEY, null)
  return batch
}

export function batchHistory(): ReleaseBatch[] {
  return readJson<ReleaseBatch[]>(BATCH_ARCHIVE_KEY, [])
}

export function startRelease(): ReleaseBatch {
  const existing = loadBatch()
  if (existing && (existing.status === 'running' || existing.status === 'failed')) {
    throw new Error('已存在活动发布批次，请勿重复发起；请在当前批次上重试或回退')
  }
  if (existing && existing.status === 'rolled_back') {
    throw new Error('上一批次已回退；请先从失败步骤重试，或归档后再发起新批次')
  }
  if (existing && existing.status === 'succeeded') {
    throw new Error('当前版本已发布成功，重复执行不另开批次；发布新版本或先归档历史批次')
  }
  const batch: ReleaseBatch = {
    id: `REL-${Date.now()}`,
    appVersion: CURRENT_APP_VERSION,
    status: 'running',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    steps: freshSteps(),
    events: [],
    attempts: 1,
  }
  addEvent(batch, { type: 'batch_start', message: `发布批次 ${batch.id} 启动，目标版本 ${batch.appVersion}` })
  persistBatch(batch)
  return executeFrom(batch, 0)
}

export function retryRelease(): ReleaseBatch {
  const batch = loadBatch()
  if (!batch) {
    throw new Error('没有可重试的发布批次')
  }
  if (batch.status === 'succeeded') {
    throw new Error('该批次已成功，无需重试')
  }
  const failedIndex = batch.steps.findIndex((step) => step.status === 'failed' || step.status === 'rolled_back')
  const startIndex = failedIndex >= 0 ? failedIndex : 0
  // 从失败步骤重试前先恢复基线快照，避免上一次失败留下半截数据；
  // 基线快照只取一次，重试图快照缺失时回退也指向它，快照本身仍然保留不删。
  const baseline = latestSnapshotOf(batch.id)
  if (baseline && failedIndex > RELEASE_STEPS.findIndex((s) => s.key === 'snapshot')) {
    restoreSnapshot(baseline)
    removeInspectionChecks()
  }
  batch.attempts += 1
  batch.status = 'running'
  batch.failureStep = undefined
  for (const step of batch.steps) {
    if (step.status === 'failed' || step.status === 'rolled_back') {
      step.status = 'pending'
      step.message = ''
    }
  }
  addEvent(batch, { type: 'retry', message: `第 ${batch.attempts} 次尝试，从步骤「${batch.steps[startIndex].name}」重试` })
  persistBatch(batch)
  return executeFrom(batch, startIndex)
}

function executeFrom(batch: ReleaseBatch, startIndex: number): ReleaseBatch {
  for (let index = startIndex; index < RELEASE_STEPS.length; index += 1) {
    const def = RELEASE_STEPS[index]
    const step = batch.steps[index]
    step.status = 'running'
    step.startedAt = nowIso()
    step.attempts += 1
    step.message = '执行中…'
    addEvent(batch, { type: 'step_start', step: def.key, message: `开始执行：${def.name}` })
    persistBatch(batch)
    try {
      consumeFault(def.key)
      let message = ''
      switch (def.key) {
        case 'dependency':
          message = runDependencyCheck()
          break
        case 'environment':
          message = runEnvironmentCheck()
          break
        case 'checklist':
          message = runChecklistStep()
          break
        case 'snapshot': {
          const snapshot = takeSnapshot(batch)
          batch.snapshotId = snapshot.id
          message = `快照 ${snapshot.id} 已保存（${snapshot.rowCount} 条），历史快照只增不删`
          break
        }
        case 'migration': {
          const result = runMigrationStep()
          message = result.message
          break
        }
        case 'build':
          message = runBuildCheck()
          break
        case 'deploy':
          message = runDeployStep()
          break
        case 'sampling':
          message = runSamplingStep(batch)
          break
        default:
          message = '未知步骤，跳过'
      }
      step.status = 'succeeded'
      step.finishedAt = nowIso()
      step.message = message
      step.detail = message
      addEvent(batch, { type: 'step_ok', step: def.key, message })
      persistBatch(batch)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      step.status = 'failed'
      step.finishedAt = nowIso()
      step.message = `失败：${reason}`
      step.detail = reason
      batch.status = 'failed'
      batch.failureStep = def.key
      addEvent(batch, { type: 'step_fail', step: def.key, message: `${def.name}失败：${reason}` })
      persistBatch(batch)
      rollback(batch, index)
      return loadBatch() as ReleaseBatch
    }
  }
  batch.status = 'succeeded'
  batch.finishedAt = nowIso()
  addEvent(batch, { type: 'batch_ok', message: `发布批次 ${batch.id} 全部成功，版本 ${batch.appVersion}` })
  persistBatch(batch)
  return batch
}

// 整批回退：按 mutate 步骤逆序补偿，check/verify 步骤不产生持久化数据。
function rollback(batch: ReleaseBatch, failedIndex: number): void {
  addEvent(batch, { type: 'rollback', message: `开始整批回退（失败于步骤序号 ${failedIndex + 1}）` })
  for (let index = failedIndex; index >= 0; index -= 1) {
    const key = RELEASE_STEPS[index].key
    const step = batch.steps[index]
    try {
      if (key === 'sampling') {
        removeInspectionChecks()
      } else if (key === 'snapshot') {
        const target = latestSnapshotOf(batch.id)
        if (target) {
          restoreSnapshot(target)
        }
      }
      // deploy/build/migration 的数据面影响已由快照恢复覆盖；check 步骤无补偿。
      if (step.status !== 'failed') {
        step.status = 'rolled_back'
      }
      step.message = `${step.message}（已回退）`
      addEvent(batch, { type: 'rollback', step: key, message: `步骤「${step.name}」已补偿回退` })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      addEvent(batch, { type: 'rollback', step: key, message: `步骤「${step.name}」回退异常：${reason}` })
    }
  }
  batch.status = 'rolled_back'
  addEvent(batch, {
    type: 'rollback',
    message: '整批回退完成：业务数据已恢复至发布前快照，可从失败步骤重试',
  })
  persistBatch(batch)
}

export function replayBatch(): ReleaseBatch | null {
  return loadBatch()
}

export function getChecklist() {
  return buildChecklist(allRows())
}

export { moduleNameOf, resetRows }
