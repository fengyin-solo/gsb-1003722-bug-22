/**
 * 水位领域规则：全链路的共同起点。
 *
 * 根因：采集值以自由文本进入 localStore，下游（水位详情 / 预警面板 / 整编列表）
 * 直接渲染原文，没有数值化与缺测标记。警戒值缺测时「无法比较」被页面当成「正常」；
 * 变幅从未与当前水位勾稽；审核不校验、不去重、不防并发。
 *
 * 本模块把判定收敛到一处：入库/读取时先 normalize，再据数值给出等级、原因与可流转动作。
 */
import type { ActionResult, EntryRow, ReviewEntry } from '@/data/types'
import { listRows, saveRows } from '@/data/local-store'

export type LevelGrade = 'normal' | 'warning' | 'guarantee' | 'missing' | 'abnormal' | 'unknown'

export type LevelField = '当前水位' | '警戒水位' | '保证水位' | '水位变幅'

export type NormalizedLevel = {
  value: number | null
  /** 缺测：空、—、null、undefined；异常：有内容但解析不出数或越出合理物理区间。 */
  kind: 'ok' | 'missing' | 'abnormal'
  raw: string
  reason: string
}

export type WaterLevelView = {
  row: EntryRow
  cur: NormalizedLevel
  warn: NormalizedLevel
  guar: NormalizedLevel
  amp: NormalizedLevel
  grade: LevelGrade
  gradeLabel: string
  /** 当前判定依据，例如「当前 27.10 ≥ 保证 27.00」；缺测时是缺测说明。 */
  gradeReason: string
  /** 变幅勾稽结果：与当前水位和上一条记录对得上时为 true。 */
  amplitudeConsistent: boolean
  /** 详情/列表统一展示的缺测说明。 */
  missingSummary: string
  /** 失败重试或中断后的原因（无则空串）。 */
  issueText: string
  /** 当前状态下真正可执行的动作。 */
  allowedActions: string[]
}

/** 水位物理合理区间（m，冻结基面）。超出即采集异常，不会被当成正常值参与比较。 */
const PHYSICAL_RANGE: Record<Exclude<LevelField, '水位变幅'>, [number, number]> = {
  当前水位: [-50, 9000],
  警戒水位: [-50, 9000],
  保证水位: [-50, 9000],
}
const AMPLITUDE_RANGE: [number, number] = [-30, 30]

const MISSING_TOKENS = new Set(['', '—', '-', '--', 'null', 'undefined', '缺测', 'nan', 'N/A', 'n/a'])

export function parseLevel(raw: unknown, field: LevelField): NormalizedLevel {
  const text = raw === null || raw === undefined ? '' : String(raw).trim()
  if (MISSING_TOKENS.has(text)) {
    return { value: null, kind: 'missing', raw: text, reason: `${field}缺测：该站本次未报送该值，不参与超警戒判定` }
  }
  // 去掉单位与空格后解析；非数字不再「悄悄当 0/正常」，明确标采集异常。
  const num = Number.parseFloat(text.replace(/[米m\s]/g, ''))
  if (!Number.isFinite(num)) {
    return { value: null, kind: 'abnormal', raw: text, reason: `${field}「${text}」无法解析为数值，按采集异常处理` }
  }
  const range = field === '水位变幅' ? AMPLITUDE_RANGE : PHYSICAL_RANGE[field]
  if (num < range[0] || num > range[1]) {
    return { value: null, kind: 'abnormal', raw: text, reason: `${field} ${num}m 超出合理区间 ${range[0]}~${range[1]}m，按采集异常处理` }
  }
  return { value: num, kind: 'ok', raw: text, reason: '' }
}

export function formatLevel(v: NormalizedLevel): string {
  if (v.kind === 'missing') return '缺测'
  if (v.kind === 'abnormal') return '异常'
  return v.value === null ? '缺测' : v.value.toFixed(2)
}

export function formatMeters(num: number | null): string {
  return num === null ? '缺测' : `${num.toFixed(2)} m`
}

function gradeOf(cur: NormalizedLevel, warn: NormalizedLevel, guar: NormalizedLevel): {
  grade: LevelGrade
  label: string
  reason: string
} {
  if (cur.kind === 'missing') {
    return { grade: 'missing', label: '缺测', reason: '当前水位缺测，无法判定是否超警戒，按缺测处理，不计正常' }
  }
  if (cur.kind === 'abnormal') {
    return { grade: 'abnormal', label: '采集异常', reason: cur.reason }
  }
  const c = cur.value as number
  // 保证水位优先（保证 > 警戒 的物理意义）。阈值缺测时只比较可用的那一级，不能因为缺一级就回落到正常。
  if (guar.kind === 'ok' && c >= (guar.value as number)) {
    return { grade: 'guarantee', label: '超保证', reason: `当前水位 ${c.toFixed(2)}m ≥ 保证水位 ${(guar.value as number).toFixed(2)}m` }
  }
  if (warn.kind === 'ok' && c >= (warn.value as number)) {
    return { grade: 'warning', label: '超警戒', reason: `当前水位 ${c.toFixed(2)}m ≥ 警戒水位 ${(warn.value as number).toFixed(2)}m` }
  }
  // 警戒缺测：即使保证水位可用且未超，也无法证明未超警戒（警戒 < 保证），不得显示正常。
  if (warn.kind !== 'ok') {
    const tail = guar.kind === 'ok'
      ? `；仅知保证水位 ${(guar.value as number).toFixed(2)}m，当前未超保证但无法判定是否超警戒`
      : '；保证水位同样缺测'
    return { grade: 'unknown', label: '警戒缺测', reason: `警戒水位缺测，无法判定等级，不计正常${tail}` }
  }
  // 到这里：未超警戒且警戒值可用。保证缺测不影响「是否正常（未超警戒）」的结论，只标注参考级别缺失。
  const used = guar.kind === 'ok'
    ? `低于警戒 ${(warn.value as number).toFixed(2)}m、保证 ${(guar.value as number).toFixed(2)}m`
    : `低于警戒 ${(warn.value as number).toFixed(2)}m（保证水位缺测，不影响超警戒判定）`
  return { grade: 'normal', label: '正常', reason: `当前水位 ${c.toFixed(2)}m，${used}` }
}

/** 变幅勾稽：变幅应由本次与上次当前水位之差得出；对不上时给出依据，以当前水位为准重算。 */
export function reconcileAmplitude(row: EntryRow, all: EntryRow[]): {
  amp: NormalizedLevel
  consistent: boolean
  expected: number | null
} {
  const cur = parseLevel(row['当前水位'], '当前水位')
  const prev = all
    .filter((item) => String(item['站点编号']) === String(row['站点编号']) && item.id !== row.id)
    .map((item) => ({ row: item, time: Date.parse(String(item['观测时间'] ?? '')) }))
    .filter((item) => Number.isFinite(item.time) && item.time < Date.parse(String(row['观测时间'] ?? '')))
    .sort((a, b) => b.time - a.time)[0]
  if (!prev || cur.kind !== 'ok') {
    const amp = parseLevel(row['水位变幅'], '水位变幅')
    return { amp, consistent: amp.kind !== 'abnormal', expected: null }
  }
  const prevCur = parseLevel(prev.row['当前水位'], '当前水位')
  if (prevCur.kind !== 'ok') {
    return { amp: parseLevel(row['水位变幅'], '水位变幅'), consistent: true, expected: null }
  }
  const expected = Number(((cur.value as number) - (prevCur.value as number)).toFixed(2))
  const raw = parseLevel(row['水位变幅'], '水位变幅')
  if (raw.kind !== 'ok') {
    // 变幅缺测/异常：直接以当前水位重算，使三者可互相核对。
    return { amp: { value: expected, kind: 'ok', raw: String(expected), reason: '' }, consistent: false, expected }
  }
  const consistent = Math.abs((raw.value as number) - expected) < 0.005
  if (!consistent) {
    // 原值与勾稽结果不符：展示以当前水位重算的值（标 * 提示），原值留在原因里。
    return {
      amp: { value: expected, kind: 'ok', raw: String(expected), reason: '' },
      consistent: false,
      expected,
    }
  }
  return { amp: raw, consistent, expected }
}

/**
 * 读取时归一化（幂等）：解析各水位字段、勾稽变幅。历史结论兼容——只补数值与判定，
 * 不改写历史记录的 status/abnormal 结论；仅在变幅可由当前水位确定重算值时回写一次该值。
 */
export function normalizeWaterLevelRow(row: EntryRow, all: EntryRow[]): WaterLevelView {
  const cur = parseLevel(row['当前水位'], '当前水位')
  const warn = parseLevel(row['警戒水位'], '警戒水位')
  const guar = parseLevel(row['保证水位'], '保证水位')
  let recon = reconcileAmplitude(row, all)
  let amp = recon.amp
  let consistent = recon.consistent
  const g = gradeOf(cur, warn, guar)

  // 变幅「缺测」时，重算值直接来自当前水位与相邻测次（口径权威），幂等补算回写一次，
  // 使「当前水位—阈值—变幅」在存储层也对得上；status/abnormal 等历史结论一律不动。
  // 变幅有原值但与勾稽不符的，不静默改数：保留不符状态，由审核环节确认后才修正。
  const rawAmpNow = parseLevel(row['水位变幅'], '水位变幅')
  const indexInAll = all.findIndex((item) => item.id === row.id)
  if (!consistent && amp.kind === 'ok' && recon.expected !== null && rawAmpNow.kind === 'missing' && indexInAll >= 0) {
    const next = [...all]
    next[indexInAll] = { ...next[indexInAll], '水位变幅': String(recon.expected) }
    saveRows('waterlevel', next)
    all = next
    row = next[indexInAll]
    recon = reconcileAmplitude(row, all)
    amp = recon.amp
    consistent = recon.consistent
  }

  const missingParts: string[] = []
  for (const part of [
    ['当前水位', cur],
    ['警戒水位', warn],
    ['保证水位', guar],
    ['水位变幅', rawAmpNow.kind === 'missing' ? (consistent ? amp : rawAmpNow) : amp],
  ] as const) {
    if (part[1].kind === 'missing') missingParts.push(part[1].reason)
    if (part[1].kind === 'abnormal') missingParts.push(part[1].reason)
  }
  if (!consistent && amp.kind === 'ok') {
    const rawText = rawAmpNow.kind === 'ok' ? `${(rawAmpNow.value as number).toFixed(2)}m` : `原值「${rawAmpNow.raw}」`
    missingParts.push(`水位变幅${rawText}与当前水位勾稽不符，已按相邻测次重算为 ${(amp.value as number).toFixed(2)}m`)
  }

  const meta = row.reviewMeta
  const issueParts: string[] = []
  if (meta?.lastError) issueParts.push(`重试失败：${meta.lastError}`)
  if (meta?.interruptReason) issueParts.push(`审核中断：${meta.interruptReason}`)
  if (meta?.rejectReason) issueParts.push(`异常原因：${meta.rejectReason}`)
  if (meta && meta.attempts > 0) issueParts.push(`已重试 ${meta.attempts} 次`)

  return {
    row,
    cur,
    warn,
    guar,
    amp,
    grade: g.grade,
    gradeLabel: g.label,
    gradeReason: g.reason,
    amplitudeConsistent: consistent,
    missingSummary: missingParts.join('；'),
    issueText: issueParts.join('；'),
    allowedActions: actionsFor(String(row.status), g.grade, consistent),
  }
}

export function listWaterLevels(): WaterLevelView[] {
  const rows = listRows('waterlevel')
  return rows.map((row) => normalizeWaterLevelRow(row, rows))
}

/** 状态机：每个状态只暴露真正成立的动作；缺测/采集异常/变幅未勾稽不允许直接通过。 */
export function actionsFor(status: string, grade: LevelGrade, amplitudeConsistent = true): string[] {
  const blocked = grade === 'missing' || grade === 'abnormal' || grade === 'unknown'
  const passBlocked = blocked || !amplitudeConsistent
  switch (status) {
    case '已采集':
      return blocked ? ['标记异常'] : ['提交审核']
    case '待审核':
      // 缺测/异常的在审记录不能确认通过；阈值缺测先补阈值；变幅对不上先确认重算值。
      if (passBlocked) {
        return blocked ? ['标记异常', '中断审核'] : ['确认重算变幅', '标记异常', '中断审核']
      }
      return ['确认通过', '标记异常', '中断审核']
    case '异常值':
      // 异常记录的「重试」必须回到待审核重新校验，不能残留为已通过。
      return ['重新校验']
    case '已通过':
      return ['发起复核']
    default:
      return []
  }
}

export const WATERLEVEL_STATUSES = ['已采集', '待审核', '已通过', '异常值']

type MutateOptions = {
  reviewer?: string
  reason?: string
  note?: string
  expectedRev?: number
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function commitReviews(): ReviewEntry[] {
  try {
    const raw = window.localStorage.getItem(REVIEW_KEY)
    return raw ? (JSON.parse(raw) as ReviewEntry[]) : []
  } catch {
    return []
  }
}

export const REVIEW_KEY = 'hydrology-monitor-station:reviews'

export function listReviews(): ReviewEntry[] {
  return commitReviews().sort((a, b) => (a.at < b.at ? 1 : -1))
}

/** 追加复核记录（水位审核与预警阈值配置共用此入口）。 */
export function appendReview(entry: Omit<ReviewEntry, 'id' | 'at'>): ReviewEntry {
  const all = commitReviews()
  const record: ReviewEntry = {
    ...entry,
    id: all.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    at: nowText(),
  }
  all.push(record)
  window.localStorage.setItem(REVIEW_KEY, JSON.stringify(all))
  return record
}

// 并发闸门：同一记录的审核在一次异步判定完成前拒绝第二发，杜绝双击/并发落两个结果。
const inFlight = new Set<number>()

function saveMeta(rows: EntryRow[], index: number, patch: Partial<EntryRow>, metaPatch: Partial<NonNullable<EntryRow['reviewMeta']>>): void {
  const prevMeta = rows[index].reviewMeta ?? { attempts: 0 }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    ...patch,
    rev: (rows[index].rev ?? 1) + 1,
    reviewMeta: { ...prevMeta, ...metaPatch },
  }
  saveRows('waterlevel', next)
}

/**
 * 水位动作统一入口。返回 ok=false 时原因写进 message，页面在行内/详情展示。
 */
export function mutateWaterLevel(id: number, action: string, options: MutateOptions = {}): ActionResult {
  let rows = listRows('waterlevel')
  let index = rows.findIndex((r) => Number(r.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的水位记录` }
  let row = rows[index]

  if (options.expectedRev !== undefined && (row.rev ?? 1) !== options.expectedRev) {
    return { ok: false, message: '该记录已被其他人审核过，页面结论已过期，请刷新后以最新结果为准' }
  }
  if (inFlight.has(id)) {
    return { ok: false, message: '该记录正在审核中，请勿重复提交，本次只保留第一个审核结果' }
  }

  let view = normalizeWaterLevelRow(row, rows)
  const allowed = view.allowedActions
  if (!allowed.includes(action)) {
    if (action === '确认通过' && (view.grade === 'missing' || view.grade === 'unknown')) {
      return { ok: false, message: `${row['记录编号']} 无法通过：${view.gradeReason}；请补齐当前水位或警戒/保证阈值后重试` }
    }
    if (action === '确认通过' && view.grade === 'abnormal') {
      return { ok: false, message: `${row['记录编号']} 无法通过：${view.gradeReason}` }
    }
    if (action === '确认通过' && !view.amplitudeConsistent) {
      return { ok: false, message: `${row['记录编号']} 无法通过：${view.missingSummary}；请确认重算变幅后再审核` }
    }
    if (action === '重新校验') {
      return { ok: false, message: '只有异常值记录才能重新校验' }
    }
    return { ok: false, message: `${row['记录编号']} 当前「${row.status}」状态不支持「${action}」` }
  }

  // 归一化可能因「缺测变幅补算」而回写过存储；重新取最新引用，避免后续保存把补算值覆盖掉。
  rows = listRows('waterlevel')
  index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的水位记录` }
  row = rows[index]
  view = normalizeWaterLevelRow(row, rows)

  inFlight.add(id)
  try {
    const reviewer = options.reviewer || '值班管理员'
    const at = nowText()
    const baseMeta = row.reviewMeta ?? { attempts: 0 }

    if (action === '提交审核') {
      saveMeta(rows, index, { status: '待审核', pending: true, abnormal: false }, {
        interruptReason: undefined,
        lastError: undefined,
      })
      appendReview({
        source: 'waterlevel', sourceLabel: '水位审核', bizKey: String(row['记录编号']),
        station: String(row['站点编号']), title: `水位记录 ${row['记录编号']}`,
        action: '提交审核', conclusion: '待复核', detail: view.gradeReason,
        reviewer, status: '待复核',
      })
      return { ok: true, message: `${row['记录编号']} 已提交审核，当前等级「${view.gradeLabel}」` }
    }

    if (action === '确认通过') {
      // 二次校验：重试/并发场景下若数据已被改成缺测或异常，仍然拦住。
      if (view.grade !== 'normal' && view.grade !== 'warning' && view.grade !== 'guarantee') {
        saveMeta(rows, index, {}, { lastError: `通过时校验未过：${view.gradeReason}` })
        return { ok: false, message: `通过被拦截：${view.gradeReason}` }
      }
      saveMeta(rows, index, { status: '已通过', pending: false, abnormal: false }, {
        reviewer, reviewedAt: at, rejectReason: undefined,
        interruptReason: undefined, lastError: undefined,
        note: options.note || (view.grade === 'normal' ? undefined : `超阈值通过：${view.gradeReason}`),
      })
      appendReview({
        source: 'waterlevel', sourceLabel: '水位审核', bizKey: String(row['记录编号']),
        station: String(row['站点编号']), title: `水位记录 ${row['记录编号']}`,
        action: '确认通过', conclusion: view.gradeLabel, detail: view.gradeReason,
        reviewer, status: '已复核', rev: (row.rev ?? 1) + 1,
      })
      return { ok: true, message: `${row['记录编号']} 已通过，等级「${view.gradeLabel}」：${view.gradeReason}` }
    }

    if (action === '标记异常') {
      const reason = options.reason || view.missingSummary || view.gradeReason || '人工判定为异常值'
      saveMeta(rows, index, { status: '异常值', pending: false, abnormal: true }, {
        rejectReason: reason, reviewer, reviewedAt: at, interruptReason: undefined, lastError: undefined,
      })
      appendReview({
        source: 'waterlevel', sourceLabel: '水位审核', bizKey: String(row['记录编号']),
        station: String(row['站点编号']), title: `水位记录 ${row['记录编号']}`,
        action: '标记异常', conclusion: '异常值', detail: reason,
        reviewer, status: '已复核',
      })
      return { ok: true, message: `${row['记录编号']} 已标记异常：${reason}` }
    }

    if (action === '中断审核') {
      const reason = options.reason || '审核中断：数据待核实，记录回到待审核并保留中断原因'
      // 中断不产生终态结论：仍为待审核，原因落库，可稍后继续。
      saveMeta(rows, index, { status: '待审核', pending: true, abnormal: false }, {
        interruptReason: reason, reviewer, lastError: undefined,
      })
      return { ok: true, message: `${row['记录编号']} 审核已中断：${reason}` }
    }

    if (action === '确认重算变幅') {
      if (view.amplitudeConsistent || view.amp.kind !== 'ok') {
        return { ok: false, message: `${row['记录编号']} 当前没有待确认的重算变幅` }
      }
      const fixed = Number((view.amp.value as number).toFixed(2))
      const next = [...rows]
      next[index] = {
        ...rows[index],
        '水位变幅': String(fixed),
        rev: (rows[index].rev ?? 1) + 1,
        status: '待审核',
        reviewMeta: {
          ...(rows[index].reviewMeta ?? { attempts: 0 }),
          reviewer,
          reviewedAt: at,
          note: `变幅原值与当前水位勾稽不符，审核确认采用重算值 ${fixed.toFixed(2)}m`,
        },
      }
      saveRows('waterlevel', next)
      appendReview({
        source: 'waterlevel', sourceLabel: '水位审核', bizKey: String(row['记录编号']),
        station: String(row['站点编号']), title: `水位记录 ${row['记录编号']}`,
        action: '确认重算变幅', conclusion: '待复核',
        detail: `审核确认采用勾稽重算值 ${fixed.toFixed(2)}m，记录维持待审核`,
        reviewer, status: '待复核',
      })
      return { ok: true, message: `${row['记录编号']} 已确认重算变幅 ${fixed.toFixed(2)}m，可继续审核通过` }
    }

    if (action === '重新校验') {
      // 异常重试：attempts +1，回待审核重新走全部校验；绝不停留在「已通过」。
      const attempts = baseMeta.attempts + 1
      // 模拟重试中的失败可能：若根因（缺测/异常）未消除，本次重试失败并保留原因。
      if (view.grade === 'missing' || view.grade === 'abnormal' || view.grade === 'unknown') {
        saveMeta(rows, index, { status: '异常值', pending: false, abnormal: true }, {
          attempts, lastError: `第 ${attempts} 次重试仍不满足通过条件：${view.gradeReason}`,
        })
        return { ok: false, message: `第 ${attempts} 次重试失败：${view.gradeReason}。记录保持「异常值」，未残留为已通过` }
      }
      saveMeta(rows, index, { status: '待审核', pending: true, abnormal: false }, {
        attempts, lastError: undefined, interruptReason: undefined,
      })
      appendReview({
        source: 'waterlevel', sourceLabel: '水位审核', bizKey: String(row['记录编号']),
        station: String(row['站点编号']), title: `水位记录 ${row['记录编号']}`,
        action: '重新校验', conclusion: '待复核',
        detail: `第 ${attempts} 次重试，数据复核已恢复，转待审核`,
        reviewer, status: '待复核',
      })
      return { ok: true, message: `${row['记录编号']} 第 ${attempts} 次重试已进入待审核，将重新校验后才能通过` }
    }

    if (action === '发起复核') {
      appendReview({
        source: 'waterlevel', sourceLabel: '水位审核', bizKey: String(row['记录编号']),
        station: String(row['站点编号']), title: `水位记录 ${row['记录编号']}`,
        action: '发起复核', conclusion: '待复核', detail: options.note || '对已通过结论发起复核',
        reviewer, status: '待复核',
      })
      return { ok: true, message: `${row['记录编号']} 已发起复核` }
    }

    return { ok: false, message: `未登记动作「${action}」` }
  } finally {
    inFlight.delete(id)
  }
}

export type CommitWaterLevelInput = {
  station: string
  observedAt: string
  current: string
  warning: string
  guarantee: string
  amplitude?: string
  reviewer?: string
}

/**
 * 登记/提交水位记录：按「站点 + 观测时间」幂等 upsert——同时提交只留一条有效记录。
 * 当前水位允许缺测（登记为缺测并直接转异常值待核实），但不会被当作正常。
 */
export function commitWaterLevel(input: CommitWaterLevelInput): { ok: boolean; message: string; view?: WaterLevelView } {
  const station = input.station.trim()
  const observedAt = input.observedAt.trim()
  if (!station) return { ok: false, message: '站点编号不能为空' }
  if (!observedAt) return { ok: false, message: '观测时间不能为空' }

  const rows = listRows('waterlevel')
  const existingIndex = rows.findIndex(
    (row) => String(row['站点编号']).trim() === station && String(row['观测时间']).trim() === observedAt,
  )

  if (existingIndex >= 0) {
    // 幂等：同站同时段已存在，只更新数值，不新增、不复制，动作流转沿用原记录。
    const next = [...rows]
    const target = next[existingIndex]
    next[existingIndex] = {
      ...target,
      rev: (target.rev ?? 1) + 1,
      '当前水位': input.current.trim(),
      '警戒水位': input.warning.trim(),
      '保证水位': input.guarantee.trim(),
      '水位变幅': (input.amplitude ?? '').trim(),
    }
    saveRows('waterlevel', next)
    const view = normalizeWaterLevelRow(next[existingIndex], next)
    return { ok: true, message: `该站该时段已存在记录 ${target['记录编号']}，已按新值覆盖，未产生重复记录`, view }
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const serial = String(id).padStart(4, '0')
  const cur = parseLevel(input.current, '当前水位')
  const row: EntryRow = {
    id,
    status: cur.kind === 'ok' ? '已采集' : '异常值',
    pending: cur.kind === 'ok',
    abnormal: cur.kind !== 'ok',
    rev: 1,
    '记录编号': `WATE-${serial}`,
    '站点编号': station,
    '观测时间': observedAt,
    '当前水位': input.current.trim(),
    '警戒水位': input.warning.trim(),
    '保证水位': input.guarantee.trim(),
    '水位变幅': (input.amplitude ?? '').trim(),
    '记录状态': cur.kind === 'ok' ? '已采集' : '缺测待核实',
    reviewMeta: cur.kind === 'ok' ? { attempts: 0 } : {
      attempts: 0,
      rejectReason: cur.reason,
    },
  }
  const next = [...rows, row]
  saveRows('waterlevel', next)
  const view = normalizeWaterLevelRow(row, next)
  return {
    ok: true,
    message: cur.kind === 'ok'
      ? `已登记水位记录 WATE-${serial}，可提交审核`
      : `已登记 WATE-${serial}，但${cur.reason}，已置为异常值待核实`,
    view,
  }
}

/** 预警阈值变更后对受影响水位记录做再判定，并写入复核链路（预警配置入口）。 */
export function reviewWarningThresholdChange(input: {
  configNo: string
  station: string
  monitorType: string
  action: string
  values: { blue?: string; yellow?: string; orange?: string; red?: string }
  reviewer?: string
}): ReviewEntry {
  const reviewer = input.reviewer || '值班管理员'
  const affected = listWaterLevels().filter((view) => String(view.row['站点编号']) === input.station)
  const overCount = affected.filter((view) => view.grade === 'warning' || view.grade === 'guarantee').length
  const detail = `阈值${input.action}，影响 ${input.station} 水位记录 ${affected.length} 条，其中当前超警戒/保证 ${overCount} 条`
  return appendReview({
    source: 'warning',
    sourceLabel: '预警阈值配置',
    bizKey: input.configNo,
    station: input.station,
    title: `${input.monitorType}阈值 ${input.configNo}`,
    action: input.action,
    conclusion: overCount > 0 ? '存在超阈值记录' : '暂无超阈值记录',
    detail,
    reviewer,
    status: '待复核',
  })
}
