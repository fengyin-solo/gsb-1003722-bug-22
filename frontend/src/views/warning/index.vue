<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          维护预警阈值配置；水位复核入口与水位监测页共用同一本复核台账，从预警面板发起的复核同样可被追溯。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <!-- 另一个预警入口：预警阈值页内的水位复核面板 -->
    <section class="panel warning-entry-panel">
      <header class="panel-head">
        <h3>水位预警复核入口</h3>
        <span class="panel-hint">与「水位监测 → 预警面板」共用复核台账，只列异常 / 待复核 / 无法研判的记录</span>
      </header>
      <table v-if="attentionRows.length" class="data-table inner-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>站点</th>
            <th>观测时间</th>
            <th>当前/警戒/保证(m)</th>
            <th>研判</th>
            <th>说明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in attentionRows" :key="row.id">
            <td>{{ row.recordCode }}</td>
            <td>{{ row.stationName }}<span class="sub-text">{{ row.stationCode }}</span></td>
            <td>{{ row.observedAt }}</td>
            <td>{{ formatLevel(row.current) }} / {{ formatLevel(row.warningLevel) }} / {{ formatLevel(row.safetyLevel) }}</td>
            <td><span :class="['verdict-tag', tagClass(row.verdict)]">{{ row.verdict }}</span></td>
            <td class="reason-cell">
              {{ row.verdictReason }}
              <span v-if="row.lastFailReason" class="fail-inline">中断原因：{{ row.lastFailReason }}</span>
            </td>
            <td class="row-actions">
              <button
                v-if="row.reviewStatus === '已采集'"
                class="link"
                type="button"
                :disabled="busyId === row.id"
                @click="submit(row)"
              >发起复核</button>
              <button
                v-if="row.reviewStatus === '异常值'"
                class="link"
                type="button"
                :disabled="busyId === row.id"
                @click="retry(row)"
              >重试复核</button>
              <span v-if="row.reviewStatus === '待审核'" class="muted-text">
                复核中（台账 #{{ row.caseId }}）
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">
        暂无需要关注的水位预警。空态说明：统一取数链路上没有超警戒、超保证、缺测、无法研判或待复核的水位记录。
      </p>

      <h4 class="ledger-title">复核台账（本页入口写入，与水位监测页同库）</h4>
      <table v-if="warningCases.length" class="data-table inner-table">
        <thead>
          <tr>
            <th>台账</th><th>记录</th><th>轮次</th><th>状态</th><th>研判快照</th><th>原因 / 说明</th><th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in warningCases" :key="item.id">
            <td>#{{ item.id }}</td>
            <td>{{ item.recordCode }}<span class="sub-text">{{ item.stationName }}</span></td>
            <td>第 {{ item.attempt }} 轮</td>
            <td><span :class="['review-tag', caseClass(item.status)]">{{ item.status }}</span></td>
            <td>{{ item.verdictSnapshot }}</td>
            <td class="reason-cell">{{ item.reason || item.note || item.reasonSnapshot }}</td>
            <td>{{ item.updatedAt }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">本入口暂无复核记录。空态说明：尚未从预警阈值页发起过水位复核。</p>
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
        <tr v-for="row in genericRows" :key="String(row.id)">
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
        <tr v-if="!genericRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值数据，可先登记预警阈值配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警阈值记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
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
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const meta = moduleMeta('warning')
const columns = ['配置编号', '站点编号', '监测类型', '蓝色阈值', '黄色阈值', '橙色阈值', '红色阈值', '生效状态']
const actions = ['发布生效', '调整阈值', '停用配置']
const statuses = ['草稿', '已生效', '已调整', '已停用']
const stats = [{ label: '配置总数', value: 0 }, { label: '已生效数', value: 0 }, { label: '本月调整数', value: 0 }]

const genericRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const message = ref('')
const messageOk = ref(false)
const busyId = ref<number | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: genericRows.value.filter((row) => String(row.status) === status).length,
  })),
)

const waterRows = ref<WaterRecord[]>([])
// 台账随 waterRows 刷新节拍一起重算（localStorage 非响应式）
const warningCases = computed(() => {
  void waterRows.value.length
  return waterService.listCases({ source: '预警面板' })
})

const ATTENTION_VERDICTS: WaterVerdict[] = ['超警戒', '超保证', '缺测', '无法研判', '异常值']
const attentionRows = computed(() =>
  waterRows.value.filter(
    (row) =>
      ATTENTION_VERDICTS.includes(row.verdict) ||
      row.reviewStatus === '待审核' ||
      row.reviewStatus === '异常值',
  ),
)

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
function caseClass(status: string): string {
  return {
    待复核: 'tag-pending',
    已通过: 'tag-pass',
    已驳回: 'tag-abnormal',
    失败中断: 'tag-danger',
  }[status] ?? 'tag-unknown'
}

async function submit(row: WaterRecord) {
  busyId.value = row.id
  const result = await waterService.submitReview({ recordId: row.id, source: '预警面板', operator: store.operator })
  busyId.value = null
  messageOk.value = result.ok
  message.value = result.message
  reloadWater()
}

async function retry(row: WaterRecord) {
  busyId.value = row.id
  const result = await waterService.retryReview({ recordId: row.id, source: '预警面板', operator: store.operator })
  busyId.value = null
  messageOk.value = result.ok
  message.value = result.message
  reloadWater()
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
    genericRows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
  reloadWater()
}

onMounted(reload)
</script>
