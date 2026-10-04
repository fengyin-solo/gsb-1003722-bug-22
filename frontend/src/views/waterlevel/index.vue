<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">当前水位与警戒/保证水位统一数值化判定：缺测明确标注、不当正常；变幅按相邻测次勾稽；异常重试必须重新校验。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

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
          <th>记录编号</th><th>站点</th><th>观测时间</th>
          <th>当前水位</th><th>警戒水位</th><th>保证水位</th><th>水位变幅</th>
          <th>判定等级</th><th>当前状态</th><th>缺测/异常说明</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in filteredViews" :key="String(view.row.id)" :class="`grade-row-${view.grade}`">
          <td><button class="link" type="button" @click="openDetail(view)">{{ view.row['记录编号'] }}</button></td>
          <td>{{ view.row['站点编号'] }}</td>
          <td>{{ view.row['观测时间'] }}</td>
          <td :class="cellClass(view.cur.kind)">{{ formatLevel(view.cur) }}</td>
          <td :class="cellClass(view.warn.kind)">{{ formatLevel(view.warn) }}</td>
          <td :class="cellClass(view.guar.kind)">{{ formatLevel(view.guar) }}</td>
          <td :class="view.amplitudeConsistent ? '' : 'cell-warn'">
            {{ formatLevel(view.amp) }}
            <span v-if="!view.amplitudeConsistent" class="hint-mark" title="变幅与当前水位勾稽不符，已按相邻测次重算">*</span>
          </td>
          <td><span class="grade-badge" :class="view.grade">{{ view.gradeLabel }}</span></td>
          <td>{{ view.row.status }}</td>
          <td class="reason-cell">{{ displayReason(view) || '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in view.allowedActions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, view)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td colspan="11" class="empty-state">
            <template v-if="hasFilter">没有符合筛选条件的水位记录，请调整检索条件后重试</template>
            <template v-else>暂无水位记录。当前水位缺测的记录会登记为「异常值-缺测待核实」，不会显示为正常；可点击「登记水位记录」补录。</template>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredViews.length }} 条水位记录；判定基准：当前 ≥ 警戒为超警戒，≥ 保证为超保证；阈值缺测不计正常</span>
      <span v-if="footMessage" :class="footOk ? 'ok-text' : 'error-text'">{{ footMessage }}</span>
    </footer>

    <!-- 水位详情 + 预警面板 -->
    <div v-if="activeView" class="modal-mask" @click.self="closeDetail">
      <div class="modal-box modal-wide">
        <header class="modal-head">
          <h3>水位详情 · {{ activeView.row['记录编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <div class="detail-grid">
          <article class="detail-card">
            <span class="stat-label">站点 / 观测时间</span>
            <strong>{{ activeView.row['站点编号'] }} · {{ activeView.row['观测时间'] }}</strong>
          </article>
          <article class="detail-card" :class="`detail-grade-${activeView.grade}`">
            <span class="stat-label">预警面板判定</span>
            <strong><span class="grade-badge" :class="activeView.grade">{{ activeView.gradeLabel }}</span></strong>
            <p class="detail-reason">{{ activeView.gradeReason }}</p>
          </article>
          <article class="detail-card">
            <span class="stat-label">当前水位</span>
            <strong>{{ formatMeters(activeView.cur.kind === 'ok' ? activeView.cur.value : null) }}</strong>
          </article>
          <article class="detail-card">
            <span class="stat-label">警戒水位</span>
            <strong>{{ formatMeters(activeView.warn.kind === 'ok' ? activeView.warn.value : null) }}</strong>
          </article>
          <article class="detail-card">
            <span class="stat-label">保证水位</span>
            <strong>{{ formatMeters(activeView.guar.kind === 'ok' ? activeView.guar.value : null) }}</strong>
          </article>
          <article class="detail-card">
            <span class="stat-label">水位变幅（勾稽后）</span>
            <strong>{{ formatMeters(activeView.amp.kind === 'ok' ? activeView.amp.value : null) }}</strong>
            <p v-if="!activeView.amplitudeConsistent" class="detail-reason">与当前水位/上一测次不符，已重算</p>
          </article>
        </div>

        <section class="detail-section">
          <h4>缺测与异常说明</h4>
          <p v-if="activeView.missingSummary" class="detail-reason">{{ activeView.missingSummary }}</p>
          <p v-else>无缺测字段，当前水位与阈值数值一致可用。</p>
          <h4>审核过程</h4>
          <ul class="meta-list">
            <li>当前状态：{{ activeView.row.status }}（版本 rev {{ activeView.row.rev ?? 1 }}）</li>
            <li v-if="activeView.row.reviewMeta?.attempts">重试次数：{{ activeView.row.reviewMeta.attempts }}</li>
            <li v-if="activeView.row.reviewMeta?.reviewer">上次审核人：{{ activeView.row.reviewMeta.reviewer }} · {{ activeView.row.reviewMeta.reviewedAt }}</li>
            <li v-if="activeView.row.reviewMeta?.lastError" class="error-text">最近重试失败：{{ activeView.row.reviewMeta.lastError }}</li>
            <li v-if="activeView.row.reviewMeta?.interruptReason" class="warn-text">中断原因：{{ activeView.row.reviewMeta.interruptReason }}</li>
            <li v-if="activeView.row.reviewMeta?.rejectReason">异常原因：{{ activeView.row.reviewMeta.rejectReason }}</li>
            <li v-if="activeView.row.reviewMeta?.note">审核备注：{{ activeView.row.reviewMeta.note }}</li>
            <li v-if="!activeView.issueText && !activeView.row.reviewMeta?.reviewedAt">暂无审核记录</li>
          </ul>
        </section>

        <footer class="modal-foot">
          <button
            v-for="action in activeView.allowedActions"
            :key="action"
            class="btn"
            :class="action === '确认通过' ? 'primary' : ''"
            type="button"
            @click="runAction(action, activeView)"
          >
            {{ action }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 登记/补录 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <form class="modal-box" @submit.prevent="submitCreate">
        <header class="modal-head">
          <h3>登记水位记录</h3>
          <button class="btn ghost" type="button" @click="creating = false">关闭</button>
        </header>
        <p class="page-desc">同一站点同一观测时间只保留一条有效记录：重复提交会覆盖原值，不会新增。当前水位留空按缺测登记。</p>
        <div class="form-grid">
          <label class="filter-item"><span>站点编号 *</span><input v-model="form.station" placeholder="如 STAT-0001" /></label>
          <label class="filter-item"><span>观测时间 *</span><input v-model="form.observedAt" placeholder="如 2026-10-04 08:00" /></label>
          <label class="filter-item"><span>当前水位（m，留空为缺测）</span><input v-model="form.current" placeholder="如 24.62" /></label>
          <label class="filter-item"><span>警戒水位（m，可空）</span><input v-model="form.warning" placeholder="如 26.50" /></label>
          <label class="filter-item"><span>保证水位（m，可空）</span><input v-model="form.guarantee" placeholder="如 27.80" /></label>
          <label class="filter-item"><span>水位变幅（m，可空，留空自动勾稽）</span><input v-model="form.amplitude" placeholder="如 0.12" /></label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <footer class="modal-foot">
          <button class="btn primary" type="submit">保存</button>
        </footer>
      </form>
    </div>

    <ReviewPanel source="waterlevel" ref="reviewPanelRef" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  commitWaterLevel,
  formatLevel,
  formatMeters,
  listWaterLevels,
  mutateWaterLevel,
} from '@/data/water-level'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import ReviewPanel from '@/views/components/ReviewPanel.vue'
import type { WaterLevelView } from '@/data/water-level'

const meta = moduleMeta('waterlevel')
const statuses = ['已采集', '待审核', '已通过', '异常值']
const filterFields = ['记录编号', '站点编号', '观测时间']

const views = ref<WaterLevelView[]>([])
const footMessage = ref('')
const footOk = ref(false)
const filters = ref<Record<string, string>>({})
const activeView = ref<WaterLevelView | null>(null)
const creating = ref(false)
const formError = ref('')
const reviewPanelRef = ref<InstanceType<typeof ReviewPanel> | null>(null)
const form = ref({ station: '', observedAt: '', current: '', warning: '', guarantee: '', amplitude: '' })

const todayStr = new Date().toISOString().slice(0, 10)

const filteredViews = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, v]) => v.trim() !== '')
  if (pairs.length === 0) return views.value
  return views.value.filter((view) =>
    pairs.every(([field, value]) =>
      String(view.row[field] ?? '').includes(value.trim()),
    ),
  )
})

const hasFilter = computed(() => Object.values(filters.value).some((v) => v.trim() !== ''))

const stats = computed(() => [
  { label: '今日采集数', value: views.value.filter((v) => String(v.row['观测时间']).startsWith(todayStr)).length },
  { label: '超警戒站次', value: views.value.filter((v) => v.grade === 'warning' || v.grade === 'guarantee').length },
  { label: '待审核记录', value: views.value.filter((v) => v.row.status === '待审核').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: views.value.filter((view) => String(view.row.status) === status).length,
  })),
)

function cellClass(kind: string): string {
  if (kind === 'missing') return 'cell-missing'
  if (kind === 'abnormal') return 'cell-abnormal'
  return ''
}

function displayReason(view: WaterLevelView): string {
  return [view.issueText, view.missingSummary, view.grade === 'unknown' ? view.gradeReason : '']
    .filter(Boolean)
    .join('；')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  form.value = { station: '', observedAt: '', current: '', warning: '', guarantee: '', amplitude: '' }
  formError.value = ''
  creating.value = true
}

function submitCreate() {
  formError.value = ''
  const result = commitWaterLevel({ ...form.value })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  creating.value = false
  footMessage.value = result.message
  footOk.value = true
  reload()
}

function openDetail(view: WaterLevelView) {
  activeView.value = view
}

function closeDetail() {
  activeView.value = null
}

function runAction(action: string, view: WaterLevelView) {
  footMessage.value = ''
  let reason: string | undefined
  if (action === '标记异常' || action === '中断审核') {
    const prompted = window.prompt(
      action === '中断审核' ? '请填写中断原因（记录回到待审核并留痕）' : '请填写异常/缺测原因',
      view.missingSummary || view.gradeReason,
    )
    if (prompted === null) return
    reason = prompted.trim() || undefined
  }
  // expectedRev 即取数时的版本：并发的第二发因版本不匹配被拒，只落一个审核结果。
  const result = mutateWaterLevel(Number(view.row.id), action, {
    reason,
    expectedRev: view.row.rev ?? 1,
  })
  footMessage.value = result.message
  footOk.value = result.ok
  reload()
  if (activeView.value && String(activeView.value.row.id) === String(view.row.id)) {
    const updated = views.value.find((item) => String(item.row.id) === String(view.row.id))
    activeView.value = updated ?? null
  }
  reviewPanelRef.value?.reload()
}

function reload() {
  footMessage.value = ''
  try {
    views.value = listWaterLevels()
  } catch (error) {
    footMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
    footOk.value = false
  }
}

onMounted(reload)
</script>

<style scoped>
.grade-badge { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
.grade-badge.normal { background: #e7f6ec; color: #1a7f37; }
.grade-badge.warning { background: #fef3e2; color: #b54708; }
.grade-badge.guarantee { background: #fde8e8; color: #b42318; }
.grade-badge.missing, .grade-badge.unknown { background: #eef2f7; color: #475569; }
.grade-badge.abnormal { background: #fde8e8; color: #b42318; }
.cell-missing { color: #475569; font-weight: 600; }
.cell-abnormal { color: #b42318; font-weight: 600; }
.cell-warn { color: #b54708; }
.hint-mark { color: #b54708; font-weight: 700; }
.reason-cell { max-width: 300px; font-size: 12px; color: var(--muted); }
.grade-row-guarantee { background: #fff7f7; }
.grade-row-missing, .grade-row-unknown { background: #fafbfd; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal-box { background: #fff; border-radius: 10px; width: 520px; max-width: 92vw; max-height: 88vh; overflow: auto; padding: 16px; }
.modal-wide { width: 760px; }
.modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.modal-head h3 { margin: 0; font-size: 16px; }
.detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
.detail-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #fbfdff; }
.detail-card strong { display: block; margin-top: 4px; font-size: 15px; }
.detail-grade-warning { background: #fff8ee; }
.detail-grade-guarantee { background: #fef2f2; }
.detail-grade-missing, .detail-grade-unknown { background: #f8fafc; }
.detail-reason { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
.detail-section h4 { font-size: 13px; margin: 12px 0 4px; }
.meta-list { margin: 0; padding-left: 18px; font-size: 13px; }
.meta-list li { margin: 2px 0; }
.modal-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
.warn-text { color: #b54708; }
.ok-text { color: #1a7f37; }
</style>
