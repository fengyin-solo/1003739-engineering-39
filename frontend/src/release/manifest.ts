import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import type { EntryRow } from '@/data/types'

// 发布清单：流水线阶段、环境/依赖要求、旧版本数据迁移、采样规则的单一事实来源。
// 浏览器里的运营概览发布入口与 scripts/ 下的 Node 回放命令都读这一份，避免两边漂移。

export { MODULES }
export const CURRENT_APP_VERSION = '1.1.0'
export const PREVIOUS_APP_VERSION = '1.0.0'

export type StepPhase = 'check' | 'mutate' | 'verify'

export type ReleaseStepDef = {
  key: string
  name: string
  desc: string
  phase: StepPhase
  // check 阶段不产生需要补偿的数据变更；mutate 失败要回退；verify 只读复核。
}

// 启动顺序由这里决定：先只读预检，再落快照，再迁移与部署，最后采样复核。
export const RELEASE_STEPS: ReleaseStepDef[] = [
  {
    key: 'dependency',
    name: '依赖核对',
    desc: '核对 vue/vite/typescript 等依赖是否齐备、版本是否满足 manifest 要求',
    phase: 'check',
  },
  {
    key: 'environment',
    name: '部署环境核对',
    desc: '核对 APP_ENV / 运行时 / 部署目标等环境变量与部署环境是否就绪',
    phase: 'check',
  },
  {
    key: 'checklist',
    name: '待办核对清单',
    desc: '汇总各业务模块登记量、待处理、异常量与待办，形成发布前核对清单',
    phase: 'check',
  },
  {
    key: 'snapshot',
    name: '发布前快照',
    desc: '对当前全量业务数据做不可变快照，快照只增不改，失败时据此回退',
    phase: 'mutate',
  },
  {
    key: 'migration',
    name: '数据库迁移',
    desc: '按版本号顺序执行旧版本数据迁移，迁移幂等且可重放',
    phase: 'mutate',
  },
  {
    key: 'build',
    name: '构建验证',
    desc: '执行类型检查与生产构建，产出带版本号的可部署产物',
    phase: 'mutate',
  },
  {
    key: 'deploy',
    name: '部署上线',
    desc: '把构建产物发布到目标部署环境（纯前端为静态目录/容器），切换版本指针',
    phase: 'mutate',
  },
  {
    key: 'sampling',
    name: '采样复核',
    desc: '对各业务模块按规则采样复核，并把核查项同步写入巡检记录入口',
    phase: 'verify',
  },
]

export type DependencyRequirement = {
  name: string
  minVersion: string
  required: boolean
  kind: 'runtime' | 'package'
}

export const DEPENDENCY_REQUIREMENTS: DependencyRequirement[] = [
  { name: 'node', minVersion: '18.0.0', required: true, kind: 'runtime' },
  { name: 'vue', minVersion: '3.4.0', required: true, kind: 'package' },
  { name: 'vue-router', minVersion: '4.3.0', required: true, kind: 'package' },
  { name: 'pinia', minVersion: '2.1.0', required: true, kind: 'package' },
  { name: 'vite', minVersion: '5.2.0', required: true, kind: 'package' },
  { name: 'typescript', minVersion: '5.4.0', required: true, kind: 'package' },
  { name: 'vue-tsc', minVersion: '2.0.0', required: true, kind: 'package' },
]

export type EnvironmentRequirement = {
  key: string
  desc: string
  // local/dev/prod 任一环境都必须满足或具备明确默认值。
  allowed: string[]
  defaultValue: string
}

export const ENVIRONMENT_REQUIREMENTS: EnvironmentRequirement[] = [
  { key: 'APP_ENV', desc: '部署环境标识', allowed: ['local', 'dev', 'staging', 'prod'], defaultValue: 'local' },
  { key: 'VITE_APP_NAME', desc: '应用名称', allowed: [], defaultValue: '水文监测站网管理系统' },
  { key: 'VITE_API_BASE', desc: '后端地址（纯前端可为空）', allowed: [], defaultValue: '' },
]

export type MigrationDef = {
  version: string
  fromVersion: string
  name: string
  desc: string
}

// 旧版本数据迁移方式：版本号顺序、只进不退、每步幂等；执行前必有快照，失败整批回退。
export const MIGRATIONS: MigrationDef[] = [
  {
    version: '1.1.0',
    fromVersion: '1.0.0',
    name: '规范化旧版记录',
    desc: '补齐旧版本缺失的 id/status/pending 字段，重算待处理标记，并写入 schema 版本戳',
  },
]

// 采样规则：每个模块至少抽 1 条，异常/待处理优先，小表全量。
export const SAMPLE_RULE = {
  minPerModule: 1,
  // 10 条以内全量复核；超过则按 异常 > 待处理 > 其余 的顺序抽取。
  fullScanUnder: 10,
  sampleRatio: 0.5,
}

export type ModuleChecklistRow = {
  key: string
  name: string
  total: number
  pending: number
  abnormal: number
  todos: number
  sampleSize: number
}

export type ReleaseChecklist = {
  generatedAt: string
  appVersion: string
  moduleCount: number
  totalRows: number
  totalPending: number
  totalAbnormal: number
  totalTodos: number
  totalSamples: number
  modules: ModuleChecklistRow[]
}

// 待办 = 待处理 + 异常（异常优先处置，不重复扣减）。
export function buildChecklist(data: Record<string, EntryRow[]>): ReleaseChecklist {
  const modules: ModuleChecklistRow[] = MODULES.map((meta) => {
    const rows = data[meta.key] ?? []
    const pending = rows.filter((row) => row.pending === true).length
    const abnormal = rows.filter((row) => row.abnormal === true).length
    const todos = new Set([
      ...rows.filter((row) => row.pending === true).map((row) => row.id),
      ...rows.filter((row) => row.abnormal === true).map((row) => row.id),
    ]).size
    const sampleSize = computeSampleSize(rows.length)
    return { key: meta.key, name: meta.name, total: rows.length, pending, abnormal, todos, sampleSize }
  })
  return {
    generatedAt: new Date().toISOString(),
    appVersion: CURRENT_APP_VERSION,
    moduleCount: modules.length,
    totalRows: modules.reduce((sum, item) => sum + item.total, 0),
    totalPending: modules.reduce((sum, item) => sum + item.pending, 0),
    totalAbnormal: modules.reduce((sum, item) => sum + item.abnormal, 0),
    totalTodos: modules.reduce((sum, item) => sum + item.todos, 0),
    totalSamples: modules.reduce((sum, item) => sum + item.sampleSize, 0),
    modules,
  }
}

export function computeSampleSize(total: number): number {
  if (total <= 0) {
    return 0
  }
  if (total < SAMPLE_RULE.fullScanUnder) {
    return total
  }
  return Math.max(SAMPLE_RULE.minPerModule, Math.ceil(total * SAMPLE_RULE.sampleRatio))
}

// 抽样选择：异常优先，其次待处理，保证抽到的确实是最需要复核的记录。
export function pickSampleRows(rows: EntryRow[], size: number): EntryRow[] {
  if (size >= rows.length) {
    return [...rows]
  }
  const scored = rows.map((row, index) => ({
    row,
    index,
    score: (row.abnormal === true ? 2 : 0) + (row.pending === true ? 1 : 0),
  }))
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, size).map((item) => item.row)
}

export function moduleNameOf(key: string): string {
  return MODULE_BY_KEY.get(key)?.name ?? key
}
