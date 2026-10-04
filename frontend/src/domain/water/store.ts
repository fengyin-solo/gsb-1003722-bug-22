import { WATER_CASE_SEED, WATER_RECORD_SEED, WATER_STATION_SEED } from './seed'
import { parseLevel } from './normalize'
import type { ReviewCase, ReviewStatus, StoredWaterRecord, WaterStation } from './types'

/**
 * 水位域持久化：独立于通用脚手架的 localStorage 键，版本化管理。
 * 依赖（存储、时钟、休眠、旧版取数）全部可注入，并发与幂等规则可直接在 Node 下验证。
 */

export const WATER_STORAGE_KEY = 'hydrology-monitor-station:water-domain:v1'
/** 旧版通用模块的存储键：首次启动时尝试迁移其中的真实水位记录 */
export const LEGACY_ENTRIES_KEY = 'hydrology-monitor-station:entries'

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type WaterState = {
  version: 1
  stations: WaterStation[]
  records: StoredWaterRecord[]
  cases: ReviewCase[]
  nextCaseId: number
  nextRecordId: number
}

/** 旧版通用记录里只取水位审核链路需要的字段 */
type LegacyWaterRow = {
  id: number
  status: string
  [field: string]: string | number | boolean
}

/**
 * 历史结论兼容边界（由本域统一决定）：
 * 1. 只迁移携带可解析当前水位的旧记录——脚手架占位文本不是真实观测，不进入水位域；
 * 2. 旧版「已通过」结论原样保留并标记 historical，归一化链路不再自动推翻；
 * 3. 旧版「异常值」保留异常态并注明原因未留档；「待审核」在新链路里无对应台账，回退为已采集重新走流程。
 */
export function migrateLegacyRows(legacy: LegacyWaterRow[]): StoredWaterRecord[] {
  const migrated: StoredWaterRecord[] = []
  for (const row of legacy) {
    const current = parseLevel(row['当前水位'])
    if (current === null) {
      continue
    }
    const recordCode = String(row['记录编号'] ?? `LEGACY-${row.id}`)
    const base: StoredWaterRecord = {
      id: -1, // 由调用方分配正式 id
      recordCode,
      stationCode: String(row['站点编号'] ?? ''),
      observedAt: String(row['观测时间'] ?? ''),
      rawCurrent: String(row['当前水位'] ?? ''),
      reviewStatus: '已采集',
      caseId: null,
    }
    const status = String(row.status ?? '')
    if (status === '已通过') {
      base.reviewStatus = '已通过'
      base.historical = true
    } else if (status === '异常值') {
      base.reviewStatus = '异常值'
      base.lastFailReason = '由旧版数据迁移：该记录曾被标记为异常，原因未留档，可重试复核'
    } else {
      // 已采集 / 待审核 统一回到已采集，由新复核链路重新提交
      base.reviewStatus = '已采集' satisfies ReviewStatus
    }
    migrated.push(base)
  }
  return migrated
}

function seedState(): WaterState {
  return {
    version: 1,
    stations: WATER_STATION_SEED.map((item) => ({ ...item })),
    records: WATER_RECORD_SEED.map((item) => ({ ...item })),
    cases: WATER_CASE_SEED.map((item) => ({ ...item })),
    nextCaseId: Math.max(...WATER_CASE_SEED.map((item) => item.id)) + 1,
    nextRecordId: Math.max(...WATER_RECORD_SEED.map((item) => item.id)) + 1,
  }
}

function readLegacyRows(storage: StorageLike): LegacyWaterRow[] {
  const raw = storage.getItem(LEGACY_ENTRIES_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, LegacyWaterRow[]>
    return Array.isArray(parsed.waterlevel) ? parsed.waterlevel : []
  } catch {
    return []
  }
}

/**
 * 载入水位域状态：首次访问从种子初始化，并把旧版通用模块里的真实水位记录并入
 * （按记录编号去重）；之后以本域存储为准。
 */
export function loadState(storage: StorageLike): WaterState {
  const raw = storage.getItem(WATER_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WaterState
      if (parsed.version === 1) {
        return parsed
      }
    } catch {
    // 损坏数据落到重建分支
    }
  }

  const state = seedState()
  const knownCodes = new Set(state.records.map((item) => item.recordCode))
  for (const legacy of migrateLegacyRows(readLegacyRows(storage))) {
    if (knownCodes.has(legacy.recordCode)) {
      continue
    }
    legacy.id = state.nextRecordId
    state.nextRecordId += 1
    state.records.push(legacy)
  }
  // 必须在迁移合并完成后再落库：提前落库会把「未迁移的种子」写死，之后刷新就再也不会迁移
  persistState(storage, state)
  return state
}

export function persistState(storage: StorageLike, state: WaterState): void {
  storage.setItem(WATER_STORAGE_KEY, JSON.stringify(state))
}

export function reseedState(storage: StorageLike): WaterState {
  const state = seedState()
  persistState(storage, state)
  return state
}
