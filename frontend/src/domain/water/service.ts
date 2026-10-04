import {
  loadState,
  persistState,
  reseedState,
  type StorageLike,
} from './store'
import { normalizeRecords } from './normalize'
import type {
  CaseSource,
  ResolveReviewInput,
  RetryReviewInput,
  ReviewCase,
  ReviewStatus,
  StoredWaterRecord,
  SubmitReviewInput,
  WaterListResult,
  WaterRecord,
  WaterStats,
} from './types'

/**
 * 水位域服务：取数、研判、审核 / 复核状态机都收敛在这里。
 *
 * 不变量：
 * 1. 一条水位记录同时最多存在一条「有效（未终结）」复核记录；
 * 2. 提交 / 重试幂等：同一记录重复提交不会产生第二条；
 * 3. 复核结论只能落一次：并发复核用 CAS 拦截，先落的赢；
 * 4. 重试必然清理上一轮的工作流痕迹（caseId、失败原因、已通过结论），杜绝残留；
 * 5. 历史（historical）已通过结论不允许任何操作，迁移后不自动推翻。
 */

export type ActionResponse<T = undefined> =
  | { ok: true; message: string; data: T }
  | { ok: false; message: string }

type Deps = {
  storage: StorageLike
  now?: () => string
  /** 模拟审核取数耗时，默认同步；测试并发时可注入真实延迟 */
  sleep?: (ms: number) => Promise<void>
}

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createWaterService(deps: Deps) {
  const sleep = deps.sleep ?? sleepDefault
  const now = deps.now ?? (() => {
    const date = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  })

  // 每条记录一把锁：提交 / 重试 / 复核结论全部串行化，保证只产生一条有效记录、只落一个结果
  const recordLocks = new Map<number, Promise<unknown>>()

  function snapshot() {
    return loadState(deps.storage)
  }
  function commit(state: ReturnType<typeof snapshot>) {
    persistState(deps.storage, state)
  }

  function listNormalized(): WaterRecord[] {
    const state = snapshot()
    return normalizeRecords(state.records, state.stations)
  }

  function listRecords(): WaterListResult {
    const items = listNormalized()
    return { items, total: items.length }
  }

  function getRecord(id: number): WaterRecord | null {
    return listNormalized().find((item) => item.id === id) ?? null
  }

  function listCases(filter?: { open?: boolean; source?: CaseSource }): ReviewCase[] {
    const cases = snapshot().cases
    return cases
      .filter((item) => (filter?.open === undefined ? true : !item.closed === filter.open))
      .filter((item) => (filter?.source ? item.source === filter.source : true))
      .sort((a, b) => b.id - a.id)
  }

  function getCase(id: number): ReviewCase | null {
    return snapshot().cases.find((item) => item.id === id) ?? null
  }

  function stats(): WaterStats {
    const items = listNormalized()
    const cases = snapshot().cases
    return {
      total: items.length,
      missing: items.filter((item) => item.verdict === '缺测').length,
      overWarning: items.filter((item) => item.verdict === '超警戒' || item.verdict === '超保证').length,
      pendingReview: cases.filter((item) => !item.closed).length,
      failedReview: cases.filter((item) => item.status === '失败中断').length,
    }
  }

  function findRecord(state: ReturnType<typeof snapshot>, id: number): StoredWaterRecord | undefined {
    return state.records.find((item) => item.id === id)
  }

  function guardOperable(record: StoredWaterRecord): string | null {
    if (record.historical) {
      return '该记录为历史已通过结论，按兼容规则不再变更审核状态'
    }
    return null
  }

  /**
   * 提交复核（水位监测、预警面板两个入口共用）。
   * 已是待审核且挂着有效台账时，幂等返回既有台账，不新建。
   */
  function submitReview(input: SubmitReviewInput): Promise<ActionResponse<{ caseId: number }>> {
    return withRecordLock(input.recordId, () => submitReviewInner(input))
  }

  function retryReview(input: RetryReviewInput): Promise<ActionResponse<{ caseId: number }>> {
    return withRecordLock(input.recordId, () => retryReviewInner(input))
  }

  /**
   * 复核结论。并发只落一个结果：
   * 网络等待在锁外完成，真正的「读台账 → 判定未终结 → 终结写回」临界区在每记录锁内，
   * 因此并发调用串行落库，第一个终结台账，其余拿到冲突提示。
   */
  async function resolveReview(input: ResolveReviewInput, delayMs = 150): Promise<ActionResponse> {
    if (delayMs > 0) {
      await sleep(delayMs)
    }
    const targetCase = getCase(input.caseId)
    if (!targetCase) {
      return { ok: false, message: `没有找到编号为 ${input.caseId} 的复核台账` }
    }
    return withRecordLock(targetCase.recordId, () => resolveReviewInner(input))
  }

  function withRecordLock<T>(recordId: number, task: () => Promise<T> | T): Promise<T> {
    const previous = recordLocks.get(recordId) ?? Promise.resolve()
    const next = previous.then(task, task)
    recordLocks.set(
      recordId,
      next.finally(() => {
        if (recordLocks.get(recordId) === next) {
          recordLocks.delete(recordId)
        }
      }),
    )
    return next
  }

  function submitReviewInner(input: SubmitReviewInput): ActionResponse<{ caseId: number }> {
    const state = snapshot()
    const record = findRecord(state, input.recordId)
    if (!record) {
      return fail(`没有找到编号为 ${input.recordId} 的水位记录`)
    }
    const guard = guardOperable(record)
    if (guard) {
      return fail(guard)
    }
    // 幂等：已有未终结台账时直接复用，调用方重复点也只留一条
    if (record.caseId !== null) {
      const existing = state.cases.find((item) => item.id === record.caseId)
      if (existing && !existing.closed) {
        return ok({ caseId: existing.id }, `该记录已在复核中（台账 #${existing.id}），无需重复提交`)
      }
    }
    if (record.reviewStatus === '已通过') {
      return fail('该记录已复核通过，不能重复提交')
    }

    const normalized = normalizeRecords(state.records, state.stations).find((item) => item.id === record.id)
    if (!normalized) {
      return fail('记录归一化失败，无法提交复核')
    }
    if (normalized.current === null) {
      return fail(`当前水位缺测（${missingDetail(normalized, '当前水位')}），补齐观测值后才能提交复核`)
    }

    // 异常 / 驳回 / 中断后再次提交等同于新一轮：沿用上一轮台账的轮次和原因留痕，
    // 保证无论从哪个入口、点「提交」还是「重试」，规则只有一套。
    const lastCase = [...state.cases]
      .reverse()
      .find((item) => item.recordId === record.id)
    if (lastCase && !lastCase.closed) {
      lastCase.closed = true
      lastCase.status = '失败中断'
      lastCase.reason = lastCase.reason || '重新提交复核：上一轮未完成，由系统自动关闭'
      lastCase.updatedAt = now()
    }
    const prevReason = record.lastFailReason?.trim() ?? ''
    const attempt = (lastCase?.attempt ?? 0) + 1

    const caseId = state.nextCaseId
    state.nextCaseId += 1
    const timestamp = now()
    state.cases.push({
      id: caseId,
      recordId: record.id,
      recordCode: record.recordCode,
      stationCode: record.stationCode,
      stationName: normalized.stationName,
      source: input.source,
      status: '待复核',
      operator: input.operator,
      note: input.note?.trim()
        ?? (attempt > 1
          ? prevReason
            ? `第 ${attempt} 轮提交；上一轮原因：${prevReason}`
            : `第 ${attempt} 轮提交`
          : ''),
      verdictSnapshot: normalized.verdict,
      reasonSnapshot: normalized.verdictReason,
      reason: '',
      attempt,
      createdAt: timestamp,
      updatedAt: timestamp,
      closed: false,
    })
    record.reviewStatus = '待审核'
    record.caseId = caseId
    delete record.lastFailReason
    commit(state)
    return ok(
      { caseId },
      attempt > 1
        ? `已第 ${attempt} 轮提交复核（台账 #${caseId}），入口：${input.source}`
        : `已提交复核（台账 #${caseId}），入口：${input.source}`,
    )
  }

  /** 重试 = 从异常 / 驳回 / 中断态再次提交；与提交复核共用同一套轮次与清理规则 */
  function retryReviewInner(input: RetryReviewInput): ActionResponse<{ caseId: number }> {
    const state = snapshot()
    const record = findRecord(state, input.recordId)
    if (!record) {
      return fail(`没有找到编号为 ${input.recordId} 的水位记录`)
    }
    const guard = guardOperable(record)
    if (guard) {
      return fail(guard)
    }
    // 待审核中直接幂等复用；已通过不可重试
    if (record.caseId !== null) {
      const existing = state.cases.find((item) => item.id === record.caseId)
      if (existing && !existing.closed) {
        return ok({ caseId: existing.id }, `该记录已在复核中（台账 #${existing.id}），重试已被合并`)
      }
    }
    if (record.reviewStatus === '已通过') {
      return fail('该记录已复核通过，无需重试')
    }
    if (record.reviewStatus === '已采集') {
      return fail('该记录尚未提交过复核，请直接提交复核')
    }
    return submitReviewInner(input)
  }

  /** 锁内执行的复核临界区：读判定与终结写回之间没有 await，状态不会被并发调用覆盖 */
  function resolveReviewInner(input: ResolveReviewInput): ActionResponse {
    const state = snapshot()
    const reviewCase = state.cases.find((item) => item.id === input.caseId)
    if (!reviewCase) {
      return fail(`没有找到编号为 ${input.caseId} 的复核台账`)
    }
    if (reviewCase.closed) {
      return fail(`台账 #${input.caseId} 已有「${reviewCase.status}」结论，并发复核只保留第一个结果`)
    }
    const record = findRecord(state, reviewCase.recordId)
    if (!record) {
      return fail('台账对应的水位记录已不存在')
    }

    if (!input.pass && !input.reason?.trim()) {
      return fail('驳回复核必须填写原因')
    }

    const timestamp = now()
    if (input.pass) {
      reviewCase.status = '已通过'
      reviewCase.reason = input.reason?.trim() ?? '复核通过：研判依据与原始观测一致'
      reviewCase.operator = input.operator
      reviewCase.updatedAt = timestamp
      reviewCase.closed = true
      record.reviewStatus = '已通过' satisfies ReviewStatus
      record.caseId = null
      delete record.lastFailReason
    } else {
      reviewCase.status = '已驳回'
      reviewCase.reason = input.reason!.trim()
      reviewCase.operator = input.operator
      reviewCase.updatedAt = timestamp
      reviewCase.closed = true
      record.reviewStatus = '异常值'
      record.caseId = null
      record.lastFailReason = input.reason!.trim()
    }
    commit(state)
    return {
      ok: true,
      data: undefined,
      message: input.pass
        ? `台账 #${input.caseId} 已通过，结论唯一落库`
        : `台账 #${input.caseId} 已驳回：${input.reason!.trim()}`,
    }
  }

  /** 取数失败 / 中断登记：必带原因，关闭当前台账并把记录打回异常值（同步临界区，无 await） */
  function markFetchFailure(recordId: number, reasonRaw: string): ActionResponse {
    const reason = reasonRaw.trim()
    if (!reason) {
      return { ok: false, message: '必须填写取数失败 / 中断原因' }
    }
    const state = snapshot()
    const record = findRecord(state, recordId)
    if (!record) {
      return { ok: false, message: `没有找到编号为 ${recordId} 的水位记录` }
    }
    const guard = guardOperable(record)
    if (guard) {
      return { ok: false, message: guard }
    }
    const timestamp = now()
    if (record.caseId !== null) {
      const reviewCase = state.cases.find((item) => item.id === record.caseId)
      if (reviewCase && !reviewCase.closed) {
        reviewCase.status = '失败中断'
        reviewCase.reason = reason
        reviewCase.updatedAt = timestamp
        reviewCase.closed = true
      }
    }
    record.reviewStatus = '异常值'
    record.caseId = null
    record.lastFailReason = reason
    commit(state)
    return { ok: true, data: undefined, message: `记录已标记为取数中断，原因已留档：${reason}` }
  }

  function resetAll(): void {
    reseedState(deps.storage)
  }

  return {
    listRecords,
    getRecord,
    listCases,
    getCase,
    stats,
    submitReview,
    retryReview,
    resolveReview,
    markFetchFailure,
    resetAll,
  }
}

function missingDetail(record: WaterRecord, field: string): string {
  return record.missing.find((item) => item.field === field)?.reason ?? '观测值缺失'
}

function fail<T = undefined>(message: string): ActionResponse<T> {
  return { ok: false, message }
}
function ok(data: { caseId: number }, message: string): ActionResponse<{ caseId: number }> {
  return { ok: true, message, data }
}

export type WaterService = ReturnType<typeof createWaterService>
