import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoredShape = { version: number; entries: Record<string, EntryRow[]> }

function seedWithVersion(): StoredShape {
  return { version: SCHEMA_VERSION, entries: clone(SEED_ROWS) }
}

function writeStorage(payload: StoredShape): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }
}

/**
 * 历史结论兼容的迁移：
 * - v1（裸 entries）：保留每条记录原有的 status / abnormal 结论，仅合并到新版本壳里；
 *   数值归一化、变幅重算在领域层读取时幂等进行，不在这里翻转历史结论。
 * - 种子新增的模块/记录会补齐，但不覆盖浏览器里已存在的同 id 记录。
 */
function migrate(raw: string | null): StoredShape {
  const fallback = seedWithVersion()
  if (!raw) {
    writeStorage(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredShape | Record<string, EntryRow[]>
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredShape).entries?.station)) {
      const shape = parsed as StoredShape
      const entries = { ...clone(SEED_ROWS), ...clone(shape.entries) }
      const next = { version: SCHEMA_VERSION, entries }
      writeStorage(next)
      return next
    }
    // v1 旧格式：裸的 module -> rows 映射。
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const legacy = parsed as Record<string, EntryRow[]>
      const entries: Record<string, EntryRow[]> = {}
      for (const key of Object.keys(clone(SEED_ROWS))) {
        const seedRows = clone(SEED_ROWS[key])
        const oldRows = legacy[key] ?? []
        const oldIds = new Set(oldRows.map((row) => Number(row.id)))
        // 旧记录结论原样保留，仅补齐缺失的版本号字段；种子里的新记录追加进去。
        entries[key] = [
          ...oldRows.map((row) => ({ rev: 1, ...row })),
          ...seedRows.filter((seedRow) => !oldIds.has(Number(seedRow.id))),
        ]
      }
      const next = { version: SCHEMA_VERSION, entries }
      writeStorage(next)
      return next
    }
    writeStorage(fallback)
    return fallback
  } catch {
    writeStorage(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

function load(): Record<string, EntryRow[]> {
  if (cache !== null) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_ROWS)
  }
  cache = migrate(window.localStorage.getItem(STORAGE_KEY)).entries
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return load()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const entries = { ...allRows(), [key]: rows }
  cache = entries
  writeStorage({ version: SCHEMA_VERSION, entries })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
