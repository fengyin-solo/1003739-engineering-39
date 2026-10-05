<template>
  <section class="release-panel">
    <header class="release-head">
      <div>
        <h3>跨模块发布检查</h3>
        <p class="page-desc">本地开发 → 构建 → 采样的可复现流水线；任一步失败整批回退，可从失败步骤重试。</p>
      </div>
      <div class="release-actions">
        <button class="btn primary" type="button" :disabled="busy" @click="start">发起发布批次</button>
        <button class="btn" type="button" :disabled="busy || !canRetry" @click="retry">从失败步骤重试</button>
        <button class="btn ghost" type="button" :disabled="busy || !batch" @click="downloadRecord">导出回放记录</button>
      </div>
    </header>

    <div v-if="batch" class="batch-meta">
      <span>批次：<strong>{{ batch.id }}</strong></span>
      <span>目标版本：{{ batch.appVersion }}</span>
      <span>状态：<em :class="`batch-status-${batch.status}`">{{ statusText(batch.status) }}</em></span>
      <span>尝试次数：{{ batch.attempts }}</span>
      <span>快照：{{ snapshotCount }} 份（只增不删）</span>
    </div>

    <ol class="step-list">
      <li v-for="step in batch?.steps ?? []" :key="step.key" class="step-item" :class="`step-${step.status}`">
        <span class="step-index">{{ stepIndex(step.key) }}</span>
        <div class="step-body">
          <div class="step-title">
            <strong>{{ step.name }}</strong>
            <span class="step-state">{{ stepStatusText(step.status) }}</span>
            <span v-if="step.attempts > 1" class="step-attempts">第 {{ step.attempts }} 次</span>
          </div>
          <p v-if="step.message" class="step-msg">{{ step.message }}</p>
        </div>
      </li>
    </ol>
    <p v-if="!batch" class="empty-state">尚无发布批次，点击「发起发布批次」生成核对清单并执行流水线。</p>

    <details class="fault-box">
      <summary>故障注入演练（验证回退与断点重试）</summary>
      <div class="fault-row">
        <select v-model="faultStep" @change="onFaultChange">
          <option value="">不注入</option>
          <option v-for="step in injectableSteps" :key="step.key" :value="step.key">
            {{ step.name }}（{{ step.key }}）
          </option>
        </select>
        <span class="fault-hint">下一次执行到该步骤会主动失败一次，触发整批回退，随后可重试通过。</span>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { RELEASE_STEPS } from '@/release/manifest'
import {
  getFaultInjection,
  loadBatch,
  loadSnapshots,
  replayRecord,
  retryRelease,
  setFaultInjection,
  startRelease,
} from '@/release/release-store'
import type { ReleaseBatch, StepStatus } from '@/release/release-store'

const batch = ref<ReleaseBatch | null>(null)
const busy = ref(false)
const faultStep = ref('')

const injectableSteps = RELEASE_STEPS.filter((step) => step.key !== 'dependency' && step.key !== 'environment')
const snapshotCount = computed(() => loadSnapshots().length)
const canRetry = computed(() => batch.value?.status === 'failed' || batch.value?.status === 'rolled_back')

function refresh() {
  batch.value = loadBatch()
  faultStep.value = getFaultInjection()
}

function stepIndex(key: string): number {
  return RELEASE_STEPS.findIndex((step) => step.key === key) + 1
}

function statusText(status: ReleaseBatch['status']): string {
  return { running: '执行中', succeeded: '已成功', failed: '失败待回退', rolled_back: '已整批回退' }[status]
}

function stepStatusText(status: StepStatus): string {
  return {
    pending: '待执行',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    skipped: '跳过',
    rolled_back: '已回退',
  }[status]
}

async function start() {
  busy.value = true
  try {
    startRelease()
  } finally {
    refresh()
    busy.value = false
  }
}

async function retry() {
  busy.value = true
  try {
    retryRelease()
  } finally {
    refresh()
    busy.value = false
  }
}

function downloadRecord() {
  const content = replayRecord()
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${batch.value?.id ?? 'release'}-replay.txt`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function onFaultChange() {
  setFaultInjection(faultStep.value === '' ? null : faultStep.value)
}

onMounted(refresh)
</script>

<style scoped>
.release-panel {
  margin-top: 24px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 8px;
  padding: 16px;
  background: #fafafa;
}
.release-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.release-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.batch-meta {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  margin: 12px 0;
  font-size: 13px;
  color: #555;
}
.batch-status-succeeded {
  color: #389e0d;
  font-style: normal;
}
.batch-status-running {
  color: #096dd9;
  font-style: normal;
}
.batch-status-failed,
.batch-status-rolled_back {
  color: #cf1322;
  font-style: normal;
}
.step-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  display: grid;
  gap: 8px;
}
.step-item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid #e8e8e8;
  background: #fff;
}
.step-index {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #f0f0f0;
  color: #666;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.step-succeeded .step-index {
  background: #f6ffed;
  color: #389e0d;
  border: 1px solid #b7eb8f;
}
.step-failed .step-index,
.step-rolled_back .step-index {
  background: #fff1f0;
  color: #cf1322;
  border: 1px solid #ffa39e;
}
.step-running .step-index {
  background: #e6f7ff;
  color: #096dd9;
  border: 1px solid #91d5ff;
}
.step-title {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.step-state {
  font-size: 12px;
  color: #888;
}
.step-attempts {
  font-size: 12px;
  color: #d46b08;
}
.step-msg {
  margin: 4px 0 0;
  font-size: 13px;
  color: #555;
}
.fault-box {
  margin-top: 14px;
  font-size: 13px;
}
.fault-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.fault-hint {
  color: #999;
}
</style>
