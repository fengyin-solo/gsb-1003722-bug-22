import assert from 'node:assert'
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'

// 以内存存储跑领域逻辑断言，避免依赖浏览器
const harness = `
import assert from 'node:assert'
import { createWaterService } from '../src/domain/water/service.ts'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    __dump: () => Object.fromEntries(map),
  }
}

let clock = 0
const svc = createWaterService({
  storage: memoryStorage(),
  now: () => '2026-09-10 08:' + String(clock++).padStart(2, '0'),
})

function byId(id) {
  return svc.getRecord(id)
}

// 1. 缺警戒/保证 → 不得判正常
const st03 = byId(9) // 南渡站，阈值全缺
assert.strictEqual(st03.verdict, '无法研判', '阈值全缺必须无法研判')
assert.ok(st03.missing.some((m) => m.field === '警戒水位'))
assert.ok(st03.missing.some((m) => m.field === '保证水位'))

const st04 = byId(10) // 双河站，保证缺、36.2 > 警戒 35
assert.strictEqual(st04.verdict, '超警戒')
assert.ok(st04.verdictReason.includes('保证水位缺测'))

// 2. 超保证 / 超警戒 / 正常 / 缺测
assert.strictEqual(byId(3).verdict, '超保证')
assert.strictEqual(byId(2).verdict, '超警戒')
assert.strictEqual(byId(1).verdict, '正常')
const missingRec = byId(4)
assert.strictEqual(missingRec.verdict, '缺测')
assert.strictEqual(missingRec.current, null)
assert.strictEqual(missingRec.variation, null)
assert.ok(missingRec.variationNote.includes('缺测'))
assert.ok(missingRec.missing.some((m) => m.field === '当前水位' && m.reason.includes('缺测')))
// 「缺测」占位符同样解析为空
assert.strictEqual(byId(7).verdict, '缺测')

// 3. 变幅同源：ST01 41.20 -> 42.80 = +1.60；42.80 -> 45.60 = +2.80
assert.strictEqual(byId(2).variation, 1.6)
assert.strictEqual(byId(3).variation, 2.8)
// ST02 首条（按时间序 36.80 的历史记录 -> 37.10 = +0.30）
assert.strictEqual(byId(5).variation, 0.3)
// 缺测记录不参与上期：ST02 37.10 -> 缺测(id7)；保证阈值缺失记录 36.20(id10 ST04 首条) 变幅缺测
assert.ok(byId(7).variation === null)
assert.ok(byId(10).variation === null && byId(10).variationNote.includes('首条'))

// 4. 空态说明字段齐备
const noStation = svc.listRecords().items.find((r) => r.missing.some((m) => m.field === '站点档案'))
assert.strictEqual(noStation, undefined, '种子站点都应配置')

// 5. 提交幂等：缺当前水位不能提交
let r = await svc.submitReview({ recordId: 4, source: '水位监测', operator: '甲' })
assert.strictEqual(r.ok, false)
assert.ok(r.message.includes('缺测'), '缺测拒绝原因应说明')

// 正常记录重复提交只有一条有效台账
r = await svc.submitReview({ recordId: 1, source: '水位监测', operator: '甲' })
assert.strictEqual(r.ok, true)
const caseId1 = r.data.caseId
r = await svc.submitReview({ recordId: 1, source: '预警面板', operator: '乙' })
assert.strictEqual(r.ok, true)
assert.strictEqual(r.data.caseId, caseId1, '重复提交必须复用同一台账')
const openFor1 = svc.listCases({ open: true }).filter((c) => c.recordId === 1)
assert.strictEqual(openFor1.length, 1)

// 并发提交（锁串行化）仍只有一条
const results = await Promise.all([
  svc.submitReview({ recordId: 2, source: '水位监测', operator: '甲' }),
  svc.submitReview({ recordId: 2, source: '预警面板', operator: '乙' }),
  svc.submitReview({ recordId: 2, source: '水位监测', operator: '丙' }),
])
const ids = results.filter((x) => x.ok).map((x) => x.data.caseId)
assert.ok(ids.every((x) => x === ids[0]) && ids.length === 3, '并发提交收敛到同一台账')
assert.strictEqual(svc.listCases({ open: true }).filter((c) => c.recordId === 2).length, 1)

// 6. 并发复核只落一个结果
const target = ids[0]
const [a, b] = await Promise.all([
  svc.resolveReview({ caseId: target, pass: true, operator: '甲' }, 30),
  svc.resolveReview({ caseId: target, pass: false, operator: '乙', reason: '数据可疑' }, 30),
])
assert.notStrictEqual(a.ok, b.ok, '并发复核必须一成一败')
assert.strictEqual(byId(2).reviewStatus, '已通过', '先落库者赢')
const c2 = svc.getCase(target)
assert.strictEqual(c2.closed, true)
assert.strictEqual(c2.status, '已通过')
// 已终结不能再改
r = await svc.resolveReview({ caseId: target, pass: false, operator: '乙', reason: '再改' }, 0)
assert.strictEqual(r.ok, false)

// 6b. 三向竞赛、延迟不同：仍恰好一个成功，记录状态与赢家一致
const racingCase = byId(1).caseId
assert.ok(racingCase, 'id1 应挂着待复核台账')
const race = await Promise.all([
  svc.resolveReview({ caseId: racingCase, pass: false, operator: 'A', reason: '甲驳回' }, 40),
  svc.resolveReview({ caseId: racingCase, pass: true, operator: 'B' }, 10),
  svc.resolveReview({ caseId: racingCase, pass: false, operator: 'C', reason: '丙驳回' }, 25),
])
assert.strictEqual(race.filter((x) => x.ok).length, 1, '三向竞赛只能有一个结论落库')
assert.strictEqual(byId(1).reviewStatus, '已通过', '延迟最短的通过者胜出')
assert.strictEqual(svc.getCase(racingCase).status, '已通过')

// 6c. 提交与重试混合竞争（异常态记录 id6）：收敛到同一条新台账，attempt 不跳跃
const mixed = await Promise.all([
  svc.submitReview({ recordId: 6, source: '水位监测', operator: '甲' }),
  svc.retryReview({ recordId: 6, source: '预警面板', operator: '乙' }),
])
assert.strictEqual(mixed.every((x) => x.ok), true)
const mixedIds = mixed.map((x) => x.data.caseId)
assert.strictEqual(mixedIds[0], mixedIds[1], '提交/重试竞争必须收敛到同一条台账')
const open6 = svc.listCases({ open: true }).filter((c) => c.recordId === 6)
assert.strictEqual(open6.length, 1)
assert.strictEqual(open6[0].attempt, 2)
const rec6Mixed = svc.getRecord(6)
assert.strictEqual(rec6Mixed.caseId, mixedIds[0])
assert.strictEqual(rec6Mixed.lastFailReason, undefined, '竞争成功后失败原因也要清掉')

// 7. 异常重试后不残留已通过：id6 已在 6c 由「异常值/失败中断」重试为待审核
const newCase = open6[0].id
assert.notStrictEqual(newCase, 3)
const rec6b = svc.getRecord(6)
assert.strictEqual(rec6b.reviewStatus, '待审核')
assert.strictEqual(rec6b.caseId, newCase)
assert.strictEqual(rec6b.lastFailReason, undefined, '失败原因必须从工作流字段清掉')
assert.strictEqual(rec6b.verdict, '超警戒', '重试后回到真实研判，不再顶异常/已通过')
// 旧台账已关闭留痕
const old = svc.getCase(3)
assert.strictEqual(old.closed, true)
assert.strictEqual(old.status, '失败中断')
assert.ok(svc.getCase(newCase).note.includes('遥测取数通道超时'), '重试台账须带上轮原因')
// 待审核中再重试 → 幂等合并
r = await svc.retryReview({ recordId: 6, source: '水位监测', operator: '乙' })
assert.strictEqual(r.ok, true)
assert.strictEqual(r.data.caseId, newCase)

// 7b. 驳回后可再次重试，旧台账关闭、轮次递增、记录先落异常再回待审核，绝不残留已通过
r = await svc.resolveReview({ caseId: newCase, pass: false, operator: '复核员', reason: '与人工比测偏差超限' }, 0)
assert.strictEqual(r.ok, true)
assert.strictEqual(svc.getRecord(6).reviewStatus, '异常值')
assert.strictEqual(svc.getRecord(6).lastFailReason, '与人工比测偏差超限')
r = await svc.retryReview({ recordId: 6, source: '预警面板', operator: '甲' })
assert.strictEqual(r.ok, true)
assert.notStrictEqual(r.data.caseId, newCase)
const rec6c = svc.getRecord(6)
assert.strictEqual(rec6c.reviewStatus, '待审核')
assert.strictEqual(rec6c.lastFailReason, undefined)
assert.strictEqual(svc.getCase(r.data.caseId).attempt, 3)

// 8. 另一个预警入口也写入同一个复核台账
r = await svc.submitReview({ recordId: 5, source: '预警面板', operator: '值班员' })
assert.strictEqual(r.ok, true)
assert.strictEqual(svc.getCase(r.data.caseId).source, '预警面板')
assert.strictEqual(svc.listCases({ open: true, source: '预警面板' }).length >= 2, true)

// 9. 历史结论兼容：id8 historical 已通过不可改
assert.strictEqual(byId(8).reviewStatus, '已通过')
assert.strictEqual(byId(8).historical, true)
assert.strictEqual(byId(8).verdict, '正常', '历史结论保留，归一化不推翻')
r = await svc.submitReview({ recordId: 8, source: '水位监测', operator: '甲' })
assert.strictEqual(r.ok, false)
assert.ok(r.message.includes('历史'))
r = await svc.retryReview({ recordId: 8, source: '水位监测', operator: '甲' })
assert.strictEqual(r.ok, false)

// 10. 取数失败登记必须带原因，且关闭台账
r = svc.markFetchFailure(5, '   ')
assert.strictEqual(r.ok, false)
r = svc.markFetchFailure(5, '通讯链路断开')
assert.strictEqual(r.ok, true)
assert.strictEqual(byId(5).reviewStatus, '异常值')
assert.ok(byId(5).verdictReason.includes('通讯链路断开'))

// 12. 旧版通用数据迁移：真实数值保留、占位文本丢弃、已通过标历史、异常值带迁移原因
function legacyStorage(rows) {
  const map = new Map()
  map.set('hydrology-monitor-station:entries', JSON.stringify({ waterlevel: rows }))
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) }
}
const migratedSvc = createWaterService({
  storage: legacyStorage([
    { id: 1, status: '已通过', '记录编号': 'OLD-1', '站点编号': 'ST01', '观测时间': '2026-08-01 08:00', '当前水位': '40.00m' },
    { id: 2, status: '异常值', '记录编号': 'OLD-2', '站点编号': 'ST02', '观测时间': '2026-08-02 08:00', '当前水位': '39.80' },
    { id: 3, status: '待审核', '记录编号': 'OLD-3', '站点编号': 'ST01', '观测时间': '2026-08-03 08:00', '当前水位': '水位监测样例3' },
    { id: 4, status: '已采集', '记录编号': 'OLD-4', '站点编号': 'ST01', '观测时间': '2026-08-04 08:00', '当前水位': '' },
  ]),
  now: () => '2026-09-10 09:00',
})
const migrated = migratedSvc.listRecords().items.filter((x) => x.recordCode.startsWith('OLD'))
assert.strictEqual(migrated.length, 2, '占位文本与空值记录必须丢弃，只迁移 2 条真实数值')
const old1 = migrated.find((x) => x.recordCode === 'OLD-1')
const old2 = migrated.find((x) => x.recordCode === 'OLD-2')
assert.strictEqual(old1.reviewStatus, '已通过')
assert.strictEqual(old1.historical, true)
assert.strictEqual(old1.current, 40)
assert.strictEqual(old2.reviewStatus, '异常值')
assert.ok(old2.lastFailReason.includes('旧版数据迁移'))
// 迁移后历史结论不可改
const mr = await migratedSvc.submitReview({ recordId: old1.id, source: '水位监测', operator: '甲' })
assert.strictEqual(mr.ok, false)

// 13. 带单位 / 千分位 / 空白占位的解析
function parseOnly(raw) {
  const map = new Map()
  map.set('hydrology-monitor-station:entries', JSON.stringify({
    waterlevel: [{ id: 1, status: '已采集', '记录编号': 'P-1', '站点编号': 'ST01', '观测时间': '2026-09-09 08:00', '当前水位': raw }],
  }))
  const one = createWaterService({
    storage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) },
    now: () => '2026-09-10 09:00',
  })
  return one.listRecords().items.find((x) => x.recordCode === 'P-1')?.current ?? null
}
assert.strictEqual(parseOnly('42.50 米'), 42.5)
assert.strictEqual(parseOnly('1,042.5'), 1042.5)
assert.strictEqual(parseOnly('  —  '), null)
assert.strictEqual(parseOnly('N/A'), null)
// 无法解析的非占位文本不进入水位域（迁移时整条跳过），避免脏观测混进研判
assert.strictEqual(parseOnly('abc'), null)

// 11. 统计
const s = svc.stats()
assert.strictEqual(s.total, 11)
assert.strictEqual(s.missing, 2, 'id4/id7 缺测')
assert.ok(s.pendingReview >= 3)

console.log('ALL DOMAIN ASSERTIONS PASSED', JSON.stringify(s))
`

mkdirSync('.tmp-test', { recursive: true })
writeFileSync('.tmp-test/harness.ts', harness)

await build({
  entryPoints: ['.tmp-test/harness.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: '.tmp-test/harness.mjs',
  logLevel: 'warning',
})

await import('./.tmp-test/harness.mjs')
