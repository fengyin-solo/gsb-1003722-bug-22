<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">
          维护整编成果；整编列表中的水位记录直接取自统一取数链路，研判、变幅、缺测说明与水位详情、预警面板完全一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
      </div>
    </header>

    <!-- 整编列表中的水位记录：与水位详情、预警面板同源，不重复判断 -->
    <section class="panel compilation-water-panel">
      <header class="panel-head">
        <h3>水位记录整编</h3>
        <span class="panel-hint">按观测时间倒序；缺测与阈值缺失均有说明，整编以审核状态与研判结论为准</span>
      </header>
      <table v-if="waterRows.length" class="data-table inner-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>站点</th>
            <th>观测时间</th>
            <th>当前水位(m)</th>
            <th>警戒水位(m)</th>
            <th>保证水位(m)</th>
            <th>水位变幅(m)</th>
            <th>研判结论</th>
            <th>审核状态</th>
            <th>备注 / 中断原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in waterRows" :key="row.id">
            <td>{{ row.recordCode }}</td>
            <td>{{ row.stationName }}<span class="sub-text">{{ row.stationCode }}</span></td>
            <td>{{ row.observedAt }}</td>
            <td>
              {{ formatLevel(row.current) }}
              <span v-if="hasMissing(row, '当前水位')" class="missing-tag" :title="missingReason(row, '当前水位')">缺</span>
            </td>
            <td>
              {{ formatLevel(row.warningLevel) }}
              <span v-if="hasMissing(row, '警戒水位')" class="missing-tag" :title="missingReason(row, '警戒水位')">缺</span>
            </td>
            <td>
              {{ formatLevel(row.safetyLevel) }}
              <span v-if="hasMissing(row, '保证水位')" class="missing-tag" :title="missingReason(row, '保证水位')">缺</span>
            </td>
            <td>
              <template v-if="row.variation !== null">{{ row.variation > 0 ? '+' : '' }}{{ row.variation.toFixed(2) }}</template>
              <span v-else class="muted-text" :title="row.variationNote">缺测</span>
            </td>
            <td><span :class="['verdict-tag', tagClass(row.verdict)]" :title="row.verdictReason">{{ row.verdict }}</span></td>
            <td>
              <span :class="['review-tag', reviewClass(row.reviewStatus)]">{{ row.reviewStatus }}</span>
              <span v-if="row.historical" class="history-tag">历史</span>
            </td>
            <td class="reason-cell">
              <span class="sub-note">{{ row.verdictReason }}</span>
              <span v-if="row.lastFailReason" class="fail-inline">中断原因：{{ row.lastFailReason }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">
        暂无可整编的水位记录。空态说明：统一取数链路尚未取得任何观测，待采集环节登记记录后，此处会与水位监测页同步出现。
      </p>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据整编记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { waterService } from '@/domain/water'
import { formatLevel } from '@/domain/water/normalize'
import type { EntryRow } from '@/data/types'
import type { WaterRecord, WaterVerdict } from '@/domain/water/types'

const meta = moduleMeta('compilation')
const columns = ["成果编号", "整编年份", "站点编号", "整编类型", "原始记录数", "整编人", "审核人", "整编状态"]
const actions = ["开始整编", "提交审核", "驳回整编"]
const statuses = ["待整编", "整编中", "待审核", "已刊印", "已驳回"]
const stats = [{"label": "待整编年度", "value": 0}, {"label": "整编中年度", "value": 0}, {"label": "已刊印成果", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 水位记录整编区：只从统一取数链路取数，页面不做任何二次研判
const waterRows = ref<WaterRecord[]>([])

function hasMissing(row: WaterRecord, field: string): boolean {
  return row.missing.some((item) => item.field === field)
}
function missingReason(row: WaterRecord, field: string): string {
  return row.missing.find((item) => item.field === field)?.reason ?? '该字段缺测'
}
function tagClass(verdict: WaterVerdict): string {
  return {
    正常: 'tag-normal',
    超警戒: 'tag-warning',
    超保证: 'tag-danger',
    异常值: 'tag-abnormal',
    缺测: 'tag-missing',
    无法研判: 'tag-unknown',
  }[verdict]
}
function reviewClass(status: string): string {
  return {
    已采集: 'tag-normal',
    待审核: 'tag-pending',
    已通过: 'tag-pass',
    异常值: 'tag-abnormal',
  }[status] ?? 'tag-unknown'
}

function reloadWater() {
  waterRows.value = waterService.listRecords().items
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
  reloadWater()
}

onMounted(reload)
</script>
