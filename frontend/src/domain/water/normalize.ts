import type {
  StoredWaterRecord,
  WaterRecord,
  WaterStation,
  WaterVerdict,
} from './types'

/**
 * 取数归一化：所有界面（水位详情、预警面板、整编列表）共同的取数起点。
 * 原始观测字符串在这里一次性完成「解析 → 缺值标注 → 阈值研判 → 变幅计算」，
 * 任何界面都不允许绕过它自行比较，从根上杜绝：
 * - 缺警戒值被静默显示成正常；
 * - 当前水位 / 保证水位 / 变幅三处互相对不上；
 * - 缺测没有原因说明。
 */

/** 缺测占位符：空串、中文占位、破折号、斜杠等一律按缺测处理 */
const MISSING_TOKENS = new Set(['', '-', '—', '–', '/', '无', 'n/a', 'na', 'null', 'undefined', '缺测'])

export function parseLevel(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  const text = String(raw).trim()
  if (MISSING_TOKENS.has(text.toLowerCase())) {
    return null
  }
  // 兼容「42.50m」「42.50 米」这类带单位文本
  const num = Number(text.replace(/[，,]/g, '').replace(/\s*(m|米)$/i, ''))
  return Number.isFinite(num) ? num : null
}

export function formatLevel(value: number | null): string {
  return value === null ? '缺测' : value.toFixed(2)
}

function compareChronologically(a: StoredWaterRecord, b: StoredWaterRecord): number {
  const at = a.observedAt.localeCompare(b.observedAt)
  return at !== 0 ? at : a.id - b.id
}

/**
 * 研判阈值结论。边界约定：
 * - 当前水位缺测 → 缺测；
 * - 警戒、保证都没配 → 无法研判（绝不默认正常）；
 * - 保证缺、警戒已超 → 超警戒并注明超保证无法确认；
 * - 警戒缺、保证已超 → 超保证；
 * - 警戒缺且未超保证 → 无法研判；
 * - 超保证优先于超警戒。
 */
function judge(
  current: number,
  warning: number | null,
  safety: number | null,
): { verdict: WaterVerdict; reason: string } {
  if (safety !== null && current > safety) {
    const over = round2(current - safety)
    if (warning === null) {
      return {
        verdict: '超保证',
        reason: `警戒水位缺测无法比对；当前水位 ${fmt(current)}m 已超保证水位 ${fmt(safety)}m（超 ${fmt(over)}m）`,
      }
    }
    return {
      verdict: '超保证',
      reason: `当前水位 ${fmt(current)}m 已超保证水位 ${fmt(safety)}m（超 ${fmt(over)}m）`,
    }
  }
  if (warning !== null && current > warning) {
    const over = round2(current - warning)
    if (safety === null) {
      return {
        verdict: '超警戒',
        reason: `当前水位 ${fmt(current)}m 已超警戒水位 ${fmt(warning)}m（超 ${fmt(over)}m）；保证水位缺测，超保证情况无法确认`,
      }
    }
    return {
      verdict: '超警戒',
      reason: `当前水位 ${fmt(current)}m 已超警戒水位 ${fmt(warning)}m（超 ${fmt(over)}m），未超保证水位 ${fmt(safety)}m`,
    }
  }
  if (warning === null || safety === null) {
    const missing = warning === null && safety === null
      ? '警戒水位、保证水位均缺测'
      : warning === null
        ? '警戒水位缺测'
        : '保证水位缺测'
    return {
      verdict: '无法研判',
      reason: `${missing}，缺少完整的比对基准，当前水位 ${fmt(current)}m 是否正常无法研判`,
    }
  }
  return {
    verdict: '正常',
    reason: `当前水位 ${fmt(current)}m，低于警戒水位 ${fmt(warning)}m、保证水位 ${fmt(safety)}m`,
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
function fmt(value: number): string {
  return value.toFixed(2)
}

/**
 * 归一化整批记录。同站变幅 = 当前水位 − 该站时间序上一条有效（当前水位不缺测）记录，
 * 首条记录或上一条缺测时变幅为 null 并给出说明，因此「当前水位、保证水位、变幅」永远同源。
 */
export function normalizeRecords(
  records: StoredWaterRecord[],
  stations: WaterStation[],
): WaterRecord[] {
  const stationMap = new Map(stations.map((item) => [item.stationCode, item]))
  const chrono = [...records].sort(compareChronologically)
  const lastValidByStation = new Map<string, number>()

  const normalizedById = new Map<number, WaterRecord>()
  for (const record of chrono) {
    const station = stationMap.get(record.stationCode)
    const stationName = station?.stationName ?? '未配置站点'
    const warningLevel = station?.warningLevel ?? null
    const safetyLevel = station?.safetyLevel ?? null
    const current = parseLevel(record.rawCurrent)

    const missing: { field: string; reason: string }[] = []
    if (!station) {
      missing.push({ field: '站点档案', reason: `站点编号 ${record.stationCode} 未在站点档案中配置` })
    }
    if (current === null) {
      missing.push({ field: '当前水位', reason: `原始值「${record.rawCurrent || '空'}」无法解析为有效水位，按缺测处理` })
    }
    if (station && warningLevel === null) {
      missing.push({ field: '警戒水位', reason: `站点「${stationName}」未配置警戒水位阈值` })
    }
    if (station && safetyLevel === null) {
      missing.push({ field: '保证水位', reason: `站点「${stationName}」未配置保证水位阈值` })
    }

    let variation: number | null = null
    let variationNote = ''
    const previous = lastValidByStation.get(record.stationCode)
    if (current !== null) {
      if (previous === undefined) {
        variationNote = '该站时间序首条有效记录，无上期值，变幅缺测'
      } else {
        variation = round2(current - previous)
        variationNote = `对比该站上期有效水位 ${fmt(previous)}m，变幅 ${variation >= 0 ? '+' : ''}${fmt(variation)}m`
      }
      lastValidByStation.set(record.stationCode, current)
    } else {
      variationNote = '当前水位缺测，变幅无法计算'
    }

    let verdict: WaterVerdict
    let verdictReason: string
    if (current === null) {
      verdict = '缺测'
      verdictReason = '当前水位缺测，未参与阈值研判'
    } else {
      const judged = judge(current, warningLevel, safetyLevel)
      verdict = judged.verdict
      verdictReason = judged.reason
    }
    // 工作流上已被标记异常的记录，研判结论上保留异常值，避免列表说正常、审核说异常
    if (record.reviewStatus === '异常值') {
      verdict = '异常值'
      verdictReason = record.lastFailReason
        ? `取数 / 复核中断：${record.lastFailReason}`
        : '该记录在审核链路中被标记为异常，等待重试复核'
    }

    normalizedById.set(record.id, {
      ...record,
      stationName,
      current,
      warningLevel,
      safetyLevel,
      variation,
      variationNote,
      verdict,
      verdictReason,
      missing,
      abnormal: record.reviewStatus === '异常值',
    })
  }

  // 列表展示按观测时间倒序（新记录在前），变幅计算始终按正序完成
  return records
    .map((record) => normalizedById.get(record.id))
    .filter((item): item is WaterRecord => Boolean(item))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id - a.id)
}
