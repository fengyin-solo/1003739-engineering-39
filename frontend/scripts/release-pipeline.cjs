#!/usr/bin/env node
/**
 * 可回放的上线流水线（本地开发 -> 构建 -> 采样）。
 *
 * 设计约定（与浏览器内运营概览发布面板完全一致）：
 *  - 同一时刻只保留一个活动发布批次：重复执行只产生一个批次，失败/运行中会被拒绝
 *  - 每个批次发布前拍不可变快照（.release/snapshots/，只增不删）
 *  - 数据库迁移：JSON 文件数据库 + schema_version 版本表，顺序执行、幂等可重放
 *  - 任一步失败：整批回退到发布前快照，并把批次停在失败步骤，可 --retry 从该步重试
 *  - 采样复核的核查项同步写入 inspection 模块（巡检入口），回退时一并撤销
 *  - 全过程写可回放发布记录 .release/records/<batch>.log
 *
 * 用法：
 *   node scripts/release-pipeline.cjs init-data          # 用示例数据初始化文件数据库
 *   node scripts/release-pipeline.cjs run                # 发起发布批次
 *   node scripts/release-pipeline.cjs retry              # 从失败步骤重试
 *   node scripts/release-pipeline.cjs status             # 查看当前批次与核对清单
 *   node scripts/release-pipeline.cjs record             # 打印可回放发布记录
 *   node scripts/release-pipeline.cjs inject <step>      # 对某步骤注入一次故障
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const RELEASE_DIR = path.join(ROOT, '.release')
const DB_DIR = path.join(RELEASE_DIR, 'db')
const SNAPSHOT_DIR = path.join(RELEASE_DIR, 'snapshots')
const RECORD_DIR = path.join(RELEASE_DIR, 'records')
const BATCH_FILE = path.join(RELEASE_DIR, 'batch.json')
const SCHEMA_FILE = path.join(DB_DIR, 'schema_version.txt')
const DB_FILE = path.join(DB_DIR, 'entries.json')
const FAULT_FILE = path.join(RELEASE_DIR, 'fault.txt')

for (const dir of [RELEASE_DIR, DB_DIR, SNAPSHOT_DIR, RECORD_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

// 确保 manifest/seed 已打包（首次运行或源文件更新后自动重建）。
const cacheDir = path.join(ROOT, '.release-cache')
ensureBundles()
const manifest = require(path.join(cacheDir, 'manifest.cjs'))
const seedBundle = require(path.join(cacheDir, 'seed.cjs'))
const SEED_ROWS = seedBundle.SEED_ROWS

// ---------------------------------------------------------------------------

function ensureBundles() {
  const targets = [
    [path.join(ROOT, 'src/release/manifest.ts'), path.join(cacheDir, 'manifest.cjs')],
    [path.join(ROOT, 'src/data/seed.ts'), path.join(cacheDir, 'seed.cjs')],
  ]
  let stale = false
  for (const [src, out] of targets) {
    if (!fs.existsSync(out) || fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs) {
      stale = true
      break
    }
  }
  if (stale) {
    execFileSync(process.execPath, [path.join(__dirname, 'bundle-release.cjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  }
}

function nowIso() {
  return new Date().toISOString()
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    return fallback
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function loadBatch() {
  return readJson(BATCH_FILE, null)
}

function saveBatch(batch) {
  batch.updatedAt = nowIso()
  writeJson(BATCH_FILE, batch)
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error('文件数据库尚未初始化，请先执行：node scripts/release-pipeline.cjs init-data')
  }
  return readJson(DB_FILE, {})
}

function saveDb(data) {
  writeJson(DB_FILE, data)
}

function schemaVersion() {
  return fs.existsSync(SCHEMA_FILE) ? fs.readFileSync(SCHEMA_FILE, 'utf8').trim() : '1.0.0'
}

function setSchemaVersion(version) {
  fs.writeFileSync(SCHEMA_FILE, version)
}

function recordFile(batchId) {
  return path.join(RECORD_DIR, `${batchId}.log`)
}

function logEvent(batch, type, step, message) {
  const line = `${nowIso()} [${type}]${step ? ` ${step}` : ''} ${message}\n`
  fs.appendFileSync(recordFile(batch.id), line)
  process.stdout.write(line)
}

// ---- 步骤实现 -------------------------------------------------------------

function compareVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) - (pb[i] || 0)
    }
  }
  return 0
}

function pkgVersionOf(name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'))
  return pkg.version
}

function stepDependency() {
  const failures = []
  for (const req of manifest.DEPENDENCY_REQUIREMENTS) {
    if (req.kind === 'runtime') {
      const actual = process.versions.node
      if (compareVersion(actual, req.minVersion) < 0) {
        failures.push(`${req.name} 需要 >=${req.minVersion}，实际 ${actual}`)
      }
      continue
    }
    const pkgPath = path.join(ROOT, 'node_modules', req.name, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      failures.push(`缺少依赖 ${req.name}`)
      continue
    }
    const actual = pkgVersionOf(req.name)
    if (compareVersion(actual, req.minVersion) < 0) {
      failures.push(`${req.name} 需要 >=${req.minVersion}，实际 ${actual}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`依赖核对未通过：${failures.join('；')}`)
  }
  return `依赖核对通过：node ${process.versions.node}，vue ${pkgVersionOf('vue')}，vite ${pkgVersionOf('vite')}`
}

function stepEnvironment() {
  const envFile = path.join(ROOT, '.env.production')
  if (!fs.existsSync(envFile)) {
    throw new Error('缺少 .env.production 部署环境配置')
  }
  const envAppEnv = process.env.APP_ENV || 'local'
  const allowed = manifest.ENVIRONMENT_REQUIREMENTS.find((item) => item.key === 'APP_ENV').allowed
  if (!allowed.includes(envAppEnv)) {
    throw new Error(`APP_ENV=${envAppEnv} 不在允许集合 ${allowed.join('/')}`)
  }
  return `部署环境就绪：APP_ENV=${envAppEnv}（${envFile} 已就位）`
}

function stepChecklist() {
  const data = loadDb()
  const checklist = manifest.buildChecklist(data)
  const line = `核对清单：${checklist.moduleCount} 模块 / ${checklist.totalRows} 登记 / 待处理 ${checklist.totalPending} / 异常 ${checklist.totalAbnormal} / 待办 ${checklist.totalTodos} / 采样 ${checklist.totalSamples}`
  writeJson(path.join(RELEASE_DIR, 'checklist.json'), checklist)
  return line
}

function stepSnapshot(batch) {
  const data = loadDb()
  const file = path.join(SNAPSHOT_DIR, `${batch.id}-s1.json`)
  if (fs.existsSync(file)) {
    return `复用批次基线快照 ${path.basename(file)}（快照只增不删）`
  }
  const snapshot = {
    id: `${batch.id}-s1`,
    batchId: batch.id,
    createdAt: nowIso(),
    appVersion: batch.appVersion,
    schemaVersion: schemaVersion(),
    payload: data,
  }
  fs.writeFileSync(file, JSON.stringify(snapshot))
  return `发布前快照已保存 ${path.basename(file)}（${Object.values(data).reduce((s, r) => s + r.length, 0)} 行）`
}

function stepMigration() {
  const current = schemaVersion()
  const pending = manifest.MIGRATIONS.filter((m) => m.fromVersion === current)
  if (pending.length === 0) {
    return `schema 已在 ${current}，迁移幂等跳过`
  }
  const data = loadDb()
  let changed = 0
  for (const migration of pending) {
    if (migration.version === '1.1.0') {
      // 与浏览器侧一致的旧版数据规范化：补 id/status/pending，写入版本戳。
      for (const meta of manifest.MODULES) {
        const rows = data[meta.key] ?? []
        data[meta.key] = rows.map((row, index) => {
          const next = { ...row }
          if (typeof next.id !== 'number') {
            next.id = index + 1
            changed += 1
          }
          if (typeof next.status !== 'string' || !meta.statuses.includes(next.status)) {
            next.status = meta.statuses[0]
            changed += 1
          }
          const lastStatus = meta.statuses[meta.statuses.length - 1]
          if (next.pending !== (next.status !== lastStatus)) {
            next.pending = next.status !== lastStatus
            changed += 1
          }
          if (typeof next.abnormal !== 'boolean') {
            next.abnormal = false
            changed += 1
          }
          return next
        })
      }
    }
    setSchemaVersion(migration.version)
  }
  saveDb(data)
  return `数据库迁移完成：规范 ${changed} 条旧记录，schema ${current} -> ${schemaVersion()}`
}

function stepBuild() {
  // 与 npm run build 一致：先 vue-tsc 类型检查，通过后再 vite 生产构建。
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env },
  })
  const distIndex = path.join(ROOT, 'dist', 'index.html')
  if (!fs.existsSync(distIndex)) {
    throw new Error('构建结束但 dist/index.html 缺失')
  }
  const assets = fs.readdirSync(path.join(ROOT, 'dist', 'assets'))
  return `类型检查与生产构建通过：dist/index.html + ${assets.length} 个产物文件`
}

function stepDeploy(batch) {
  // 纯前端部署：把 dist 固化为带版本号的 release 目录（静态托管/容器挂载点），切换 current 指针。
  const targetRoot = path.join(RELEASE_DIR, 'artifacts')
  const target = path.join(targetRoot, batch.appVersion)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(path.join(ROOT, 'dist'), target, { recursive: true })
  const current = path.join(targetRoot, 'current')
  try {
    fs.unlinkSync(current)
  } catch {}
  fs.symlinkSync(batch.appVersion, current, 'dir')
  return `部署完成：产物发布到 .release/artifacts/${batch.appVersion}，current 指针已切换`
}

function stepSampling(batch) {
  const data = loadDb()
  const pruned = pruneReleaseChecks(data)
  const checklist = manifest.buildChecklist(data)
  let inspected = 0
  for (const item of checklist.modules) {
    inspected += manifest.pickSampleRows(data[item.key] ?? [], item.sampleSize).length
  }
  // 核查项同步写入巡检记录（另一巡检入口）
  const checks = checklist.modules
    .filter((item) => item.sampleSize > 0)
    .map((item, index) => ({
      id: 900000 + index,
      status: '已巡检',
      pending: false,
      abnormal: item.abnormal > 0,
      记录编号: `REL-CHK-${String(index + 1).padStart(3, '0')}`,
      站点编号: batch.id,
      巡检日期: nowIso().slice(0, 10),
      巡检人员: '发布流水线',
      检查项目: `发布采样复核·${item.name}（抽样${item.sampleSize}/${item.total}，异常${item.abnormal}，待处理${item.pending}）`,
      发现问题: item.abnormal > 0 ? `存在 ${item.abnormal} 条异常记录，需优先处置` : '抽样未见异常',
      处理措施: item.abnormal > 0 ? '已登记异常台账，待业务模块处置后复核' : '无需处理',
      巡检状态: item.abnormal > 0 ? '发现故障' : '已巡检',
    }))
  data.inspection = [...(data.inspection ?? []), ...checks]
  saveDb(data)
  return `采样复核 ${inspected} 条，巡检入口同步核查项 ${checks.length} 条`
}

// 采样写入幂等：重放前清掉本批次与历史批次遗留的 REL-CHK 核查项，保证核查项不翻倍。
function pruneReleaseChecks(data) {
  const before = (data.inspection ?? []).length
  data.inspection = (data.inspection ?? []).filter(
    (row) => !String(row['记录编号']).startsWith('REL-CHK-'),
  )
  return before - data.inspection.length
}

const STEP_HANDLERS = {
  dependency: () => stepDependency(),
  environment: () => stepEnvironment(),
  checklist: () => stepChecklist(),
  snapshot: (batch) => stepSnapshot(batch),
  migration: () => stepMigration(),
  build: () => stepBuild(),
  deploy: (batch) => stepDeploy(batch),
  sampling: (batch) => stepSampling(batch),
}

// ---- 回退 -----------------------------------------------------------------

function undoSampling() {
  if (!fs.existsSync(DB_FILE)) {
    return
  }
  const data = loadDb()
  data.inspection = (data.inspection ?? []).filter(
    (row) => !String(row['记录编号']).startsWith('REL-CHK-'),
  )
  saveDb(data)
}

function restoreSnapshot(batch) {
  const file = path.join(SNAPSHOT_DIR, `${batch.id}-s1.json`)
  if (!fs.existsSync(file)) {
    throw new Error(`回退失败：找不到快照 ${path.basename(file)}`)
  }
  const snapshot = readJson(file, null)
  saveDb(snapshot.payload)
  setSchemaVersion(snapshot.schemaVersion || '1.0.0')
}

function removeDeploy(batch) {
  const current = path.join(RELEASE_DIR, 'artifacts', 'current')
  try {
    if (fs.realpathSync(current).endsWith(batch.appVersion)) {
      fs.unlinkSync(current)
    }
  } catch {}
  // 失败版本的产物目录保留用于排查，但 current 指针绝不能指向它。
}

function rollback(batch, failedIndex) {
  logEvent(batch, 'rollback', null, `开始整批回退（失败于第 ${failedIndex + 1} 步）`)
  for (let i = failedIndex; i >= 0; i -= 1) {
    const def = manifest.RELEASE_STEPS[i]
    try {
      if (def.key === 'sampling') {
        undoSampling()
      } else if (def.key === 'deploy') {
        removeDeploy(batch)
      } else if (def.key === 'snapshot') {
        restoreSnapshot(batch)
      }
      if (batch.steps[i].status !== 'failed') {
        batch.steps[i].status = 'rolled_back'
      }
      logEvent(batch, 'rollback', def.key, `步骤「${def.name}」已补偿回退`)
    } catch (error) {
      logEvent(batch, 'rollback', def.key, `步骤「${def.name}」回退异常：${error.message}`)
    }
  }
  batch.status = 'rolled_back'
  logEvent(batch, 'rollback', null, '整批回退完成：数据恢复至发布前快照，可执行 retry 从失败步骤重试')
}

// ---- 编排 -----------------------------------------------------------------

function freshSteps() {
  return manifest.RELEASE_STEPS.map((def) => ({
    key: def.key,
    name: def.name,
    status: 'pending',
    attempts: 0,
    message: '',
  }))
}

function consumeFault(stepKey) {
  if (fs.existsSync(FAULT_FILE) && fs.readFileSync(FAULT_FILE, 'utf8').trim() === stepKey) {
    fs.unlinkSync(FAULT_FILE)
    throw new Error(`故障注入：步骤「${stepKey}」被主动置为失败`)
  }
}

function executeFrom(batch, startIndex) {
  for (let i = startIndex; i < manifest.RELEASE_STEPS.length; i += 1) {
    const def = manifest.RELEASE_STEPS[i]
    const step = batch.steps[i]
    step.status = 'running'
    step.startedAt = nowIso()
    step.attempts += 1
    step.message = '执行中…'
    saveBatch(batch)
    logEvent(batch, 'step_start', def.key, `开始执行：${def.name}`)
    try {
      consumeFault(def.key)
      const message = STEP_HANDLERS[def.key](batch)
      step.status = 'succeeded'
      step.finishedAt = nowIso()
      step.message = message
      logEvent(batch, 'step_ok', def.key, message)
      saveBatch(batch)
    } catch (error) {
      step.status = 'failed'
      step.finishedAt = nowIso()
      step.message = `失败：${error.message}`
      batch.status = 'failed'
      batch.failureStep = def.key
      logEvent(batch, 'step_fail', def.key, `${def.name}失败：${error.message}`)
      saveBatch(batch)
      rollback(batch, i)
      saveBatch(batch)
      process.exitCode = 1
      return
    }
  }
  batch.status = 'succeeded'
  batch.finishedAt = nowIso()
  logEvent(batch, 'batch_ok', null, `发布批次 ${batch.id} 全部成功，版本 ${batch.appVersion}`)
  saveBatch(batch)
}

function archiveBatch() {
  const batch = loadBatch()
  if (!batch) {
    return
  }
  const archiveDir = path.join(RELEASE_DIR, 'archive')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.renameSync(BATCH_FILE, path.join(archiveDir, `${batch.id}.json`))
}

function cmdRun() {
  const existing = loadBatch()
  if (existing && (existing.status === 'running' || existing.status === 'failed')) {
    throw new Error(`已存在活动批次 ${existing.id}（${existing.status}），重复执行只保留一个批次；请 retry 或人工处理`)
  }
  if (existing && existing.status === 'rolled_back') {
    throw new Error(`上一批次 ${existing.id} 已回退；请先 retry 完成它，或执行 archive 归档后再发起新批次`)
  }
  if (existing && existing.status === 'succeeded') {
    throw new Error(`批次 ${existing.id} 已成功发布当前版本；重复执行不另开批次。需要新版本时改 manifest 版本号，或先 archive`)
  }
  const batch = {
    id: `REL-${Date.now()}`,
    appVersion: manifest.CURRENT_APP_VERSION,
    status: 'running',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    steps: freshSteps(),
    attempts: 1,
  }
  saveBatch(batch)
  logEvent(batch, 'batch_start', null, `发布批次启动，目标版本 ${batch.appVersion}`)
  executeFrom(batch, 0)
}

function cmdRetry() {
  const batch = loadBatch()
  if (!batch) {
    throw new Error('没有可重试的批次')
  }
  if (batch.status === 'succeeded') {
    throw new Error('批次已成功，无需重试')
  }
  let startIndex = batch.steps.findIndex((s) => s.status === 'failed' || s.status === 'rolled_back')
  if (startIndex < 0) {
    startIndex = 0
  }
  // 重试前先恢复基线快照，保证从干净状态从失败步骤重放
  const snapshotIndex = manifest.RELEASE_STEPS.findIndex((s) => s.key === 'snapshot')
  if (startIndex > snapshotIndex && fs.existsSync(path.join(SNAPSHOT_DIR, `${batch.id}-s1.json`))) {
    restoreSnapshot(batch)
    undoSampling()
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
  saveBatch(batch)
  logEvent(batch, 'retry', null, `第 ${batch.attempts} 次尝试，从「${batch.steps[startIndex].name}」重试`)
  executeFrom(batch, startIndex)
}

function cmdInitData() {
  if (fs.existsSync(DB_FILE)) {
    console.log('文件数据库已存在，跳过初始化（如需重建请先删除 .release/db/entries.json）')
    return
  }
  // 模拟一份「旧版本」数据：缺 schema 戳、个别记录缺字段，供迁移步骤处理。
  const legacy = JSON.parse(JSON.stringify(SEED_ROWS))
  legacy.waterlevel.push({
    id: 'LEGACY-1',
    // 旧记录没有 pending/abnormal，status 也需要规范化
    记录编号: 'LEGACY-0001',
    站点编号: 'LEGACY-0001',
    观测时间: '2026-08-31',
    当前水位: '历史遗留记录',
    警戒水位: '-',
    保证水位: '-',
    水位变幅: '-',
    记录状态: '历史遗留记录',
  })
  saveDb(legacy)
  setSchemaVersion('1.0.0')
  console.log('文件数据库已用示例数据初始化（含 1 条 1.0.0 旧版遗留记录）')
}

function cmdStatus() {
  const batch = loadBatch()
  if (!batch) {
    console.log('暂无发布批次')
  } else {
    console.log(`批次 ${batch.id}  版本 ${batch.appVersion}  状态 ${batch.status}  尝试 ${batch.attempts}`)
    for (const step of batch.steps) {
      console.log(`  [${step.status.padEnd(10)}] ${step.name}${step.message ? ' — ' + step.message : ''}`)
    }
  }
  if (fs.existsSync(DB_FILE)) {
    const checklist = manifest.buildChecklist(loadDb())
    console.log(
      `\n核对清单：${checklist.moduleCount} 模块 / ${checklist.totalRows} 登记 / 待处理 ${checklist.totalPending} / 异常 ${checklist.totalAbnormal} / 待办 ${checklist.totalTodos}`,
    )
  }
  const snaps = fs.existsSync(SNAPSHOT_DIR) ? fs.readdirSync(SNAPSHOT_DIR) : []
  console.log(`快照 ${snaps.length} 份；schema ${schemaVersion()}`)
}

function cmdRecord() {
  const batch = loadBatch()
  if (!batch) {
    throw new Error('暂无发布批次')
  }
  const file = recordFile(batch.id)
  if (!fs.existsSync(file)) {
    throw new Error('发布记录文件缺失')
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'))
}

function cmdInject(stepKey) {
  const valid = manifest.RELEASE_STEPS.some((s) => s.key === stepKey)
  if (!valid) {
    throw new Error(`未知步骤：${stepKey}`)
  }
  fs.writeFileSync(FAULT_FILE, stepKey)
  console.log(`已注入一次性故障：下一次执行到「${stepKey}」将失败并触发整批回退`)
}

const [command, arg] = process.argv.slice(2)
try {
  switch (command) {
    case 'init-data':
      cmdInitData()
      break
    case 'run':
      cmdRun()
      break
    case 'retry':
      cmdRetry()
      break
    case 'status':
      cmdStatus()
      break
    case 'record':
      cmdRecord()
      break
    case 'inject':
      cmdInject(arg)
      break
    case 'archive':
      archiveBatch()
      console.log('当前批次已归档到 .release/archive/，可发起新批次')
      break
    default:
      console.log('用法: init-data | run | retry | status | record | inject <step>')
      process.exitCode = 1
  }
} catch (error) {
  console.error(`错误：${error.message}`)
  process.exitCode = 1
}
