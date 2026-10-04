/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 乐观锁版本号：每次状态流转 +1，审核必须携带取数时的版本，防止并发审核覆盖结论。 */
  rev?: number
  /** 水位记录的审核过程信息：失败原因、中断原因、重试次数等。 */
  reviewMeta?: ReviewMeta
  [field: string]: unknown
}

/** 审核过程留痕：失败重试或中断后，页面凭它展示「原因」而不是只给一个状态。 */
export type ReviewMeta = {
  attempts: number
  reviewer?: string
  reviewedAt?: string
  rejectReason?: string
  interruptReason?: string
  lastError?: string
  note?: string
}

/** 复核记录：水位审核与预警阈值配置两个入口写入同一条复核链路。 */
export type ReviewEntry = {
  id: number
  source: 'waterlevel' | 'warning'
  sourceLabel: string
  bizKey: string
  station: string
  title: string
  action: string
  conclusion: string
  detail: string
  reviewer: string
  at: string
  status: '待复核' | '已复核'
  rev?: number
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
