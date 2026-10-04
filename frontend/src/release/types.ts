/**
 * 上线流水线（发布检查流程）的核心类型。
 *
 * 设计约束：
 * - 流水线是确定性的：同样的输入重放得到同样的步骤结果（采样按固定规则取，而非随机）。
 * - 批次按 APP_VERSION 幂等：同一个版本重复执行只保留一个发布批次。
 * - 快照只追加不删除；回退不删快照，保证「已有快照不能丢」。
 */

/** 单个发布步骤的标识，顺序即定义顺序（启动顺序固定，不允许页面调整）。 */
export type StepKey =
  | 'local-dev'
  | 'dependencies'
  | 'build'
  | 'deploy-env'
  | 'db-snapshot'
  | 'db-migrate'
  | 'checklist'
  | 'inspection-sync'
  | 'deploy'
  | 'sample'

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'rolled-back' | 'kept'

/** 步骤执行产生的结构化产出，会原样写进可回放的发布记录。 */
export type StepArtifact = Record<string, string | number | boolean | (string | number)[]>

export type StepLog = {
  at: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export type StepState = {
  key: StepKey
  name: string
  status: StepStatus
  attempts: number
  startedAt?: string
  endedAt?: string
  error?: string
  artifact?: StepArtifact
  logs: StepLog[]
}

/** 一个业务模块的核对清单行：模块、待处理、异常量与待办建议。 */
export type ModuleChecklistRow = {
  key: string
  name: string
  total: number
  pending: number
  abnormal: number
  /** 按非终态状态聚合出的待办，如「待审核 ×2 → 提交审核」。 */
  todos: { status: string; count: number; suggest: string }[]
}

/** 上线采样结果：固定步长抽样，逐条核对结构字段。 */
export type SampleFinding = {
  moduleKey: string
  id: number
  status: string
  ok: boolean
  problems: string[]
}

/** 数据库（localStorage）版本迁移的单步定义。 */
export type Migration = {
  version: number
  title: string
  description: string
  up: (data: Record<string, unknown>) => void
}

/** 快照是发布前整库的只读副本，按批次追加保存。 */
export type SnapshotRecord = {
  id: string
  batchId: string
  appVersion: string
  schemaBefore: number
  schemaAfter: number
  checksum: string
  rows: Record<string, EntryLike[]>
  createdAt: string
}

export type EntryLike = {
  id: number
  status: string
  pending?: boolean
  abnormal?: boolean
  [field: string]: unknown
}

/** 存储适配器：浏览器用 localStorage，Node 测试用内存 Map。 */
export type StorageAdapter = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 运行环境注入：构建期写死的版本与依赖清单由 Vite define 注入，Node 侧直接传。 */
export type RuntimeInfo = {
  appVersion: string
  sourceHash: string
  builtAt: string
  requiredDeps: { name: string; declared: string | null }[]
}

export type BatchStatus =
  | 'running'
  | 'rolled-back'
  | 'succeeded'

/** 一次发布的完整记录，可整体导出、回放。 */
export type ReleaseBatch = {
  batchId: string
  appVersion: string
  sourceHash: string
  schemaVersion: number
  status: BatchStatus
  startedAt: string
  endedAt?: string
  attempt: number
  resumeFrom?: StepKey
  failedAt?: StepKey
  steps: Record<StepKey, StepState>
  checklist?: ModuleChecklistRow[]
  samples?: SampleFinding[]
  snapshots: string[]
  events: BatchEvent[]
}

export type BatchEvent = {
  at: string
  kind: 'start' | 'step-ok' | 'step-failed' | 'rollback-begin' | 'rollback-end' | 'retry' | 'finish'
  step?: StepKey
  message: string
}

/** 流水线运行参数。 */
export type ReleaseOptions = {
  storage: StorageAdapter
  runtime: RuntimeInfo
  /** 演练开关：让指定步骤失败，用于验证整批回退与失败点重试。 */
  injectFailureAt?: StepKey
  /** 采样基数：默认每模块抽 3 条（不足全取）。 */
  sampleSize?: number
  /** 批次失败后是否自动从失败步骤再试一次，默认开。 */
  autoRetry?: boolean
  now?: () => Date
}

export const STEP_ORDER: StepKey[] = [
  'local-dev',
  'dependencies',
  'build',
  'deploy-env',
  'db-snapshot',
  'db-migrate',
  'checklist',
  'inspection-sync',
  'deploy',
  'sample',
]

export const STEP_NAMES: Record<StepKey, string> = {
  'local-dev': '本地开发核对',
  dependencies: '依赖核对',
  build: '构建产物核对',
  'deploy-env': '部署环境核对',
  'db-snapshot': '数据库快照',
  'db-migrate': '旧版本数据迁移',
  checklist: '模块核对清单',
  'inspection-sync': '巡检核查项同步',
  deploy: '上线部署',
  sample: '上线采样',
}
