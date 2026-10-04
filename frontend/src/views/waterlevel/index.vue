<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          当前水位、警戒/保证阈值与水位变幅均由统一取数链路研判；缺测、阈值缺失都会显式标注，不再按正常显示。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetDomain">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 预警面板：水位监测页内的预警入口，复核直接写入同一个复核台账 -->
    <section class="panel warning-panel">
      <header class="panel-head">
        <h3>预警面板</h3>
        <span class="panel-hint">按站点汇总最新研判；「发起复核」与列表操作写入同一本复核台账</span>
      </header>
      <table v-if="warningRows.length" class="data-table inner-table">
        <thead>
          <tr>
            <th>站点</th>
            <th>最新观测时间</th>
            <th>当前水位(m)</th>
            <th>警戒/保证(m)</th>
            <th>研判</th>
            <th>说明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in warningRows" :key="row.stationCode">
            <td>{{ row.stationName }}<span class="sub-text">{{ row.stationCode }}</span></td>
            <td>{{ row.latest ? row.latest.observedAt : '—' }}</td>
            <td>
              <template v-if="row.latest">
                <span :class="['verdict-tag', tagClass(row.latest.verdict)]">{{ formatLevel(row.latest.current) }}</span>
              </template>
              <span v-else class="muted-text">无记录</span>
            </td>
            <td>{{ formatLevel(row.warningLevel) }} / {{ formatLevel(row.safetyLevel) }}</td>
            <td>
              <span v-if="row.latest" :class="['verdict-tag', tagClass(row.latest.verdict)]">{{ row.latest.verdict }}</span>
            </td>
            <td class="reason-cell">{{ row.latest ? row.latest.verdictReason : '该站暂无水位记录，空态：尚未采集到任何观测' }}</td>
            <td class="row-actions">
              <button v-if="row.latest" class="link" type="button" @click="quickReview(row.latest)">发起复核</button>
              <button v-if="row.latest" class="link" type="button" @click="openDetail(row.latest.id)">详情</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无水位记录，空态说明：统一取数链路尚未取得任何观测，请先由采集环节登记记录。</p>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>站点编号 / 名称</span>
        <input v-model="filters.keyword" placeholder="按站点编号或名称检索" />
      </label>
      <label class="filter-item">
        <span>研判结论</span>
        <select v-model="filters.verdict">
          <option value="">全部</option>
          <option v-for="item in verdictOptions" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
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
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in tableRows" :key="row.id">
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
            <template v-if="row.variation !== null">
              <span :class="variationClass(row.variation)">{{ row.variation > 0 ? '+' : '' }}{{ row.variation.toFixed(2) }}</span>
            </template>
            <span v-else class="muted-text" :title="row.variationNote">缺测</span>
          </td>
          <td>
            <span :class="['verdict-tag', tagClass(row.verdict)]" :title="row.verdictReason">{{ row.verdict }}</span>
            <span v-if="row.historical" class="history-tag" title="迁移自旧版的已通过结论，按历史结论兼容规则保留">历史</span>
          </td>
          <td>
            <span :class="['review-tag', reviewClass(row.reviewStatus)]">{{ row.reviewStatus }}</span>
            <span v-if="row.lastFailReason" class="fail-reason" :title="row.lastFailReason">中断原因</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row.id)">详情</button>
            <button
              v-if="row.reviewStatus === '已采集'"
              class="link"
              type="button"
              :disabled="busyId === row.id"
              @click="submit(row, '水位监测')"
            >提交复核</button>
            <button
              v-if="row.reviewStatus === '异常值'"
              class="link"
              type="button"
              :disabled="busyId === row.id"
              @click="retry(row)"
            >重试复核</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="10" class="empty-state">
            {{ emptyHint }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ totalShown }} 条水位记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 详情抽屉 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>水位详情 · {{ detail.recordCode }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <dt>站点</dt><dd>{{ detail.stationName }}（{{ detail.stationCode }}）</dd>
          <dt>观测时间</dt><dd>{{ detail.observedAt }}</dd>
          <dt>当前水位</dt>
          <dd>
            {{ formatLevel(detail.current) }} m
            <p v-if="hasMissing(detail, '当前水位')" class="missing-note">{{ missingReason(detail, '当前水位') }}</p>
          </dd>
          <dt>警戒水位</dt>
          <dd>
            {{ formatLevel(detail.warningLevel) }} m
            <p v-if="hasMissing(detail, '警戒水位')" class="missing-note">{{ missingReason(detail, '警戒水位') }}</p>
          </dd>
          <dt>保证水位</dt>
          <dd>
            {{ formatLevel(detail.safetyLevel) }} m
            <p v-if="hasMissing(detail, '保证水位')" class="missing-note">{{ missingReason(detail, '保证水位') }}</p>
          </dd>
          <dt>水位变幅</dt>
          <dd>
            <template v-if="detail.variation !== null">{{ detail.variation > 0 ? '+' : '' }}{{ detail.variation.toFixed(2) }} m</template>
            <span v-else class="muted-text">缺测</span>
            <p class="sub-note">{{ detail.variationNote }}</p>
          </dd>
          <dt>研判结论</dt>
          <dd><span :class="['verdict-tag', tagClass(detail.verdict)]">{{ detail.verdict }}</span><p class="sub-note">{{ detail.verdictReason }}</p></dd>
          <dt>审核状态</dt>
          <dd>
            <span :class="['review-tag', reviewClass(detail.reviewStatus)]">{{ detail.reviewStatus }}</span>
            <span v-if="detail.historical" class="history-tag">历史结论</span>
            <p v-if="detail.lastFailReason" class="missing-note">失败 / 中断原因：{{ detail.lastFailReason }}</p>
          </dd>
        </dl>

        <section v-if="detailCase" class="detail-case">
          <h4>复核台账 #{{ detailCase.id }}（第 {{ detailCase.attempt }} 轮 · 来源：{{ detailCase.source }}）</h4>
          <p class="sub-note">提交时研判快照：{{ detailCase.verdictSnapshot }} — {{ detailCase.reasonSnapshot }}</p>
          <p v-if="detailCase.note" class="sub-note">备注：{{ detailCase.note }}</p>
          <p v-if="detailCase.reason" class="missing-note">处理原因：{{ detailCase.reason }}</p>
          <p>状态：<span :class="['review-tag', caseClass(detailCase.status)]">{{ detailCase.status }}</span></p>
          <div v-if="!detailCase.closed && detail.reviewStatus === '待审核'" class="case-actions">
            <button class="btn primary" type="button" :disabled="resolving" @click="resolve(true)">确认通过</button>
            <button class="btn danger" type="button" :disabled="resolving" @click="resolve(false)">驳回（标记异常）</button>
            <input v-model="rejectReason" placeholder="驳回 / 中断原因（驳回必填）" />
          </div>
        </section>
        <section v-else class="detail-actions">
          <button
            v-if="detail.reviewStatus === '已采集'"
            class="btn primary"
            type="button"
            :disabled="busyId === detail.id"
            @click="submit(detail, '水位监测')"
          >提交复核</button>
          <button
            v-if="detail.reviewStatus === '异常值'"
            class="btn primary"
            type="button"
            :disabled="busyId === detail.id"
            @click="retry(detail)"
          >重试复核</button>
          <button class="btn" type="button" :disabled="busyId === detail.id" @click="markInterrupt">登记取数中断</button>
          <input v-model="interruptReason" placeholder="中断原因（必填，留档便于重试追溯）" />
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { waterService } from '@/domain/water'
import { formatLevel } from '@/domain/water/normalize'
import type { ReviewCase, WaterRecord, WaterVerdict } from '@/domain/water/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const verdictOptions: WaterVerdict[] = ['正常', '超警戒', '超保证', '异常值', '缺测', '无法研判']

const rows = ref<WaterRecord[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const busyId = ref<number | null>(null)
const resolving = ref(false)
const rejectReason = ref('')
const interruptReason = ref('')
const detailId = ref<number | null>(null)
// 抽屉内操作后服务端状态会变（localStorage 非响应式），用节拍强制 detail 重算
const tick = ref(0)

const filters = ref({ keyword: '', verdict: '' })

const statCards = computed(() => {
  void rows.value
  const s = waterService.stats()
  return [
    { label: '水位记录总数', value: s.total },
    { label: '缺测记录', value: s.missing },
    { label: '超警戒 / 超保证', value: s.overWarning },
    { label: '待复核', value: s.pendingReview },
    { label: '失败中断', value: s.failedReview },
  ]
})

const warningRows = computed(() => {
  const map = new Map<string, { stationCode: string; stationName: string; warningLevel: number | null; safetyLevel: number | null; latest: WaterRecord | null }>()
  for (const row of rows.value) {
    const existing = map.get(row.stationCode) ?? {
      stationCode: row.stationCode,
      stationName: row.stationName,
      warningLevel: row.warningLevel,
      safetyLevel: row.safetyLevel,
      latest: null,
    }
    if (!existing.latest || row.observedAt > existing.latest.observedAt) {
      existing.latest = row
    }
    map.set(row.stationCode, existing)
  }
  return [...map.values()].sort((a, b) => b.stationCode.localeCompare(a.stationCode))
})

const filtered = computed(() =>
  rows.value.filter((row) => {
    const keyword = filters.value.keyword.trim()
    if (keyword && !row.stationCode.includes(keyword) && !row.stationName.includes(keyword) && !row.recordCode.includes(keyword)) {
      return false
    }
    if (filters.value.verdict && row.verdict !== filters.value.verdict) {
      return false
    }
    return true
  }),
)

const rowsShown = computed(() => (filters.value.keyword.trim() || filters.value.verdict ? filtered.value : rows.value))
const totalShown = computed(() => rowsShown.value.length)

// 模板只渲染 rowsShown
const tableRows = rowsShown

const emptyHint = computed(() => {
  if (total.value === 0) {
    return '暂无水位记录。空态说明：统一取数链路尚未取得任何观测，请先由采集环节登记水位记录。'
  }
  return '没有符合筛选条件的记录。空态说明：当前站点/研判条件下无记录，可重置查询条件查看全部记录。'
})

const detail = computed(() => {
  void tick.value
  return detailId.value === null ? null : waterService.getRecord(detailId.value)
})
const detailCase = computed<ReviewCase | null>(() => {
  void tick.value
  if (!detail.value || detail.value.caseId === null) {
    return null
  }
  return waterService.getCase(detail.value.caseId)
})

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  const payload = waterService.listRecords()
  rows.value = payload.items
  total.value = payload.total
  tick.value += 1
}

function resetFilters() {
  filters.value = { keyword: '', verdict: '' }
}

function resetDomain() {
  waterService.resetAll()
  reload()
  notify(true, '已恢复为水位域示例数据')
}

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
function caseClass(status: string): string {
  return {
    待复核: 'tag-pending',
    已通过: 'tag-pass',
    已驳回: 'tag-abnormal',
    失败中断: 'tag-danger',
  }[status] ?? 'tag-unknown'
}
function variationClass(value: number): string {
  if (value > 0) return 'rise-text'
  if (value < 0) return 'fall-text'
  return 'muted-text'
}

function openDetail(id: number) {
  detailId.value = id
  rejectReason.value = ''
  interruptReason.value = ''
}
function closeDetail() {
  detailId.value = null
}

async function submit(row: WaterRecord, source: '水位监测' | '预警面板') {
  busyId.value = row.id
  const result = await waterService.submitReview({ recordId: row.id, source, operator: store.operator })
  busyId.value = null
  notify(result.ok, result.message)
  reload()
}

async function quickReview(row: WaterRecord) {
  await submit(row, '预警面板')
  openDetail(row.id)
}

async function retry(row: WaterRecord) {
  busyId.value = row.id
  // 预警面板与列表都可发起重试，来源沿用最近一次台账来源，默认水位监测入口
  const result = await waterService.retryReview({ recordId: row.id, source: '水位监测', operator: store.operator })
  busyId.value = null
  notify(result.ok, result.message)
  reload()
}

async function resolve(pass: boolean) {
  if (!detailCase.value || !detail.value) {
    return
  }
  if (!pass && !rejectReason.value.trim()) {
    notify(false, '驳回复核必须填写原因')
    return
  }
  resolving.value = true
  const result = await waterService.resolveReview({
    caseId: detailCase.value.id,
    pass,
    operator: store.operator,
    reason: rejectReason.value,
  })
  resolving.value = false
  notify(result.ok, result.message)
  rejectReason.value = ''
  reload()
}

function markInterrupt() {
  if (!detail.value) {
    return
  }
  if (!interruptReason.value.trim()) {
    notify(false, '登记取数中断必须填写原因')
    return
  }
  const result = waterService.markFetchFailure(detail.value.id, interruptReason.value)
  notify(result.ok, result.message)
  interruptReason.value = ''
  reload()
}

onMounted(reload)
</script>
