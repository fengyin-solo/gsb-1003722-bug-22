/**
 * 水位域公共类型。
 *
 * 全链路（水位详情 / 预警面板 / 整编列表 / 复核台账）只认这里的归一化结构：
 * 原始记录先解析成 WaterRecord，再由同一个入口研判 verdict，任何界面都不得
 * 直接渲染原始字符串，避免缺值被当成正常、变幅和当前水位对不上这类问题。
 */

/** 研判结论：由归一化链路统一给出，界面不再各自判断 */
export type WaterVerdict =
  | '正常'
  | '超警戒'
  | '超保证'
  | '异常值'
  | '缺测'
  | '无法研判'

/** 审核工作流状态：与研判结论相互独立 */
export type ReviewStatus = '已采集' | '待审核' | '已通过' | '异常值'

/** 复核台账单条记录的处理状态 */
export type CaseStatus = '待复核' | '已通过' | '已驳回' | '失败中断'

/** 复核 / 预警两个入口的来源标记，台账里都能追溯 */
export type CaseSource = '水位监测' | '预警面板'

/** 站点阈值：警戒水位、保证水位以站点为准，记录里不再各存一份 */
export type WaterStation = {
  stationCode: string
  stationName: string
  /** 警戒水位（米），null 表示该站未配置阈值 */
  warningLevel: number | null
  /** 保证水位（米），null 表示该站未配置阈值 */
  safetyLevel: number | null
}

/** 持久化的原始记录：只存观测值与审核工作流字段，派生值不落库 */
export type StoredWaterRecord = {
  id: number
  recordCode: string
  stationCode: string
  observedAt: string
  /** 原始当前水位字符串；空串 / 缺测占位符 / 无法解析的文本都视为缺测 */
  rawCurrent: string
  /** 审核工作流状态 */
  reviewStatus: ReviewStatus
  /** 最近一次复核台账编号；重试会清空并换新 */
  caseId: number | null
  /** 历史结论：迁移自旧版数据的已通过结论，后续不自动推翻 */
  historical?: boolean
  /** 最近一次失败 / 中断原因（重试时转存到台账历史里） */
  lastFailReason?: string
}

/** 归一化后的记录：三个界面真正渲染的结构 */
export type WaterRecord = StoredWaterRecord & {
  stationName: string
  current: number | null
  warningLevel: number | null
  safetyLevel: number | null
  /** 与上一条同站记录相比的水位变幅（米），首条或缺测为 null */
  variation: number | null
  variationNote: string
  verdict: WaterVerdict
  /** 研判说明：缺值原因、超阈值幅度等都写在这里 */
  verdictReason: string
  /** 缺测字段及原因，空数组表示没有缺值 */
  missing: { field: string; reason: string }[]
  abnormal: boolean
}

/** 提交/重试复核时的入参 */
export type SubmitReviewInput = {
  recordId: number
  source: CaseSource
  operator: string
  note?: string
}

/** 复核结论入参 */
export type ResolveReviewInput = {
  caseId: number
  pass: boolean
  operator: string
  /** 驳回或失败中断时必须给出原因 */
  reason?: string
}

/** 重试入参 */
export type RetryReviewInput = {
  recordId: number
  source: CaseSource
  operator: string
  note?: string
}

/** 复核台账记录：一次提交一条；同一水位记录同时只允许一条有效（未终结）记录 */
export type ReviewCase = {
  id: number
  recordId: number
  recordCode: string
  stationCode: string
  stationName: string
  source: CaseSource
  status: CaseStatus
  operator: string
  note: string
  /** 提交时的研判快照，复核时对照用 */
  verdictSnapshot: WaterVerdict
  reasonSnapshot: string
  reason: string
  attempt: number
  createdAt: string
  updatedAt: string
  /** 终结后即为历史记录；重试会另开新记录 */
  closed: boolean
}

export type WaterListResult = {
  items: WaterRecord[]
  total: number
}

export type WaterStats = {
  total: number
  missing: number
  overWarning: number
  pendingReview: number
  failedReview: number
}
