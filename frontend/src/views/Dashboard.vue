<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，并提供可复现的跨模块发布检查流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th><th>待办</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td :class="{ 'warn-num': row.pending > 0 }">{{ row.pending }}</td>
          <td :class="{ 'err-num': row.abnormal > 0 }">{{ row.abnormal }}</td>
          <td>{{ row.todos }}</td>
        </tr>
      </tbody>
    </table>

    <ReleasePanel @finished="refresh" />

    <footer class="page-foot">
      <span>业务数据与发布记录都保存在本机浏览器里；发布前整库快照只追加不删除，可在「巡检记录」查看同步的发布核查项</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'
import ReleasePanel from '@/views/Dashboard/ReleasePanel.vue'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

onMounted(refresh)
</script>
