// 用 esbuild 即时转译 TS 并做模块解析，直接跑领域规则断言，不依赖浏览器。
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '..', 'src')
const cache = new Map()

function loadTs(id) {
  let file = id
  if (id.startsWith('@/')) file = path.join(SRC, id.slice(2))
  if (!file.endsWith('.ts')) file += '.ts'
  if (cache.has(file)) return cache.get(file).exports
  const source = fs.readFileSync(file, 'utf8')
  const out = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    sourcefile: file,
  })
  const module = { exports: {} }
  cache.set(file, module)
  const localRequire = (dep) => {
    if (dep.startsWith('@/')) return loadTs(dep)
    if (dep.startsWith('.')) return loadTs(path.resolve(path.dirname(file), dep))
    return require(dep)
  }
  const fn = new Function('require', 'module', 'exports', out.code)
  fn(localRequire, module, module.exports)
  return module.exports
}

function mockStorage() {
  const mem = new Map()
  global.window = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
  }
  return mem
}

let passed = 0
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`)
  passed += 1
  console.log('  ✓', msg)
}

async function main() {
  mockStorage()
  const wl = await loadTs('@/data/water-level')
  const ls = await loadTs('@/data/local-store')

  // 以种子数据初始化
  ls.allRows()

  console.log('1) 缺警戒值不得判定为正常')
  const views = wl.listWaterLevels()
  const byNo = (no) => views.find((v) => String(v.row['记录编号']) === no)
  assert(byNo('WATE-20260904-01').grade !== 'normal', '两级阈值均缺测 → 非 normal（' + byNo('WATE-20260904-01').gradeLabel + '）')
  const onlyGuar = byNo('WATE-20260905-01')
  assert(onlyGuar.grade !== 'normal', '仅警戒缺测（保证可用且未超）→ 非 normal（' + onlyGuar.gradeLabel + '）')
  assert(byNo('WATE-20260903-02').grade === 'missing', '当前水位缺测 → missing')
  assert(byNo('WATE-20260904-03').grade === 'abnormal', '非数字当前水位 → abnormal')
  assert(byNo('WATE-20260902-01').grade === 'warning', '超警戒 → warning')
  assert(byNo('WATE-20260903-01').grade === 'guarantee', '超保证 → guarantee')
  assert(byNo('WATE-20260901-01').grade === 'normal', '完整且低于阈值 → normal')

  console.log('2) 变幅与当前水位勾稽')
  const badAmp = byNo('WATE-20260904-02')
  assert(badAmp.amplitudeConsistent === false, 'WATE-20260904-02 变幅勾稽不符')
  // 24.90(09-04) - 26.71(09-02 同站紧邻测次) = -1.81
  assert(Math.abs(badAmp.amp.value - -1.81) < 1e-9, '变幅已按相邻测次重算为 -1.81m，实际 ' + badAmp.amp.value)

  console.log('2b) 变幅未勾稽时不能确认通过，审核确认重算值后放行')
  const ampId = badAmp.row.id
  const ampPass = wl.mutateWaterLevel(ampId, '确认通过', { expectedRev: 1 })
  assert(ampPass.ok === false, '变幅不符的在审记录确认通过被拦截：' + ampPass.message)
  const confirmAmp = wl.mutateWaterLevel(ampId, '确认重算变幅', { expectedRev: 1 })
  assert(confirmAmp.ok, '审核确认重算变幅：' + confirmAmp.message)
  const ampView2 = wl.listWaterLevels().find((v) => v.row.id === ampId)
  assert(ampView2.amplitudeConsistent === true && String(ampView2.row['水位变幅']) === '-1.81', '重算值已固化，变幅勾稽一致')
  const ampPass2 = wl.mutateWaterLevel(ampId, '确认通过', { expectedRev: ampView2.row.rev })
  assert(ampPass2.ok && ls.listRows('waterlevel').find((r) => r.id === ampId).status === '已通过', '勾稽一致后审核通过')

  console.log('3) 缺测记录确认通过被拦截')
  const missingId = byNo('WATE-20260903-02').row.id
  const tryPass = wl.mutateWaterLevel(missingId, '确认通过', { expectedRev: 4 })
  assert(tryPass.ok === false, '缺测记录确认通过返回失败')
  assert(ls.listRows('waterlevel').find((r) => r.id === missingId).status === '异常值', '缺测记录未残留为已通过')

  console.log('4) 异常记录重试：根因未消除时失败且保留原因，不残留已通过')
  const retry1 = wl.mutateWaterLevel(missingId, '重新校验')
  assert(retry1.ok === false, '缺测未消除，重试失败')
  const afterRetry = ls.listRows('waterlevel').find((r) => r.id === missingId)
  assert(afterRetry.status === '异常值', '重试失败后仍为异常值')
  assert(afterRetry.abnormal === true, 'abnormal 仍为 true')
  assert(afterRetry.reviewMeta.attempts === 3, '重试次数累加到 3，实际 ' + afterRetry.reviewMeta.attempts)
  assert(Boolean(afterRetry.reviewMeta.lastError), '保留了失败原因：' + afterRetry.reviewMeta.lastError)

  console.log('5) 补测后重试 → 待审核 → 校验通过')
  // 幂等补录同站同时段
  const fix = wl.commitWaterLevel({
    station: 'STAT-0002', observedAt: '2026-09-03 20:00',
    current: '26.90', warning: '27.00', guarantee: '27.80',
  })
  assert(fix.ok && fix.view.grade === 'normal', '补录后等级 normal')
  const fixedRows = ls.listRows('waterlevel')
  assert(fixedRows.filter((r) => String(r['观测时间']) === '2026-09-03 20:00' && String(r['站点编号']) === 'STAT-0002').length === 1, '同站同时段只有一条记录')
  const fixedId = fixedRows.find((r) => String(r['记录编号']) === 'WATE-20260903-02').id
  const retry2 = wl.mutateWaterLevel(fixedId, '重新校验')
  assert(retry2.ok && ls.listRows('waterlevel').find((r) => r.id === fixedId).status === '待审核', '重试进入待审核')
  const fixedRow = ls.listRows('waterlevel').find((r) => r.id === fixedId)
  const pass = wl.mutateWaterLevel(fixedId, '确认通过', { expectedRev: fixedRow.rev })
  assert(pass.ok && ls.listRows('waterlevel').find((r) => r.id === fixedId).status === '已通过', '重新校验后可通过')
  const persisted = ls.listRows('waterlevel').find((r) => r.id === fixedId)
  assert(String(persisted['水位变幅']) === '-1.14', `缺测变幅已补算并持久化（-1.14），实际 ${persisted['水位变幅']}`)

  console.log('6) 同时提交只留一条有效记录')
  wl.commitWaterLevel({ station: 'STAT-0009', observedAt: '2026-10-04 08:00', current: '23.10', warning: '25.00', guarantee: '26.00' })
  wl.commitWaterLevel({ station: 'STAT-0009', observedAt: '2026-10-04 08:00', current: '23.20', warning: '25.00', guarantee: '26.00' })
  const dup = ls.listRows('waterlevel').filter((r) => String(r['站点编号']) === 'STAT-0009')
  assert(dup.length === 1, '并发同站同时段提交只剩 1 条')
  assert(String(dup[0]['当前水位']) === '23.20', '保留最新值 23.20')

  console.log('7) 并发审核只落一个结果（版本号乐观锁）')
  const target = byNo('WATE-20260902-01').row.id
  const revAtRead = 1
  const r1 = wl.mutateWaterLevel(target, '确认通过', { expectedRev: revAtRead })
  const r2 = wl.mutateWaterLevel(target, '标记异常', { expectedRev: revAtRead })
  assert(r1.ok && r2.ok === false, '第一发通过成功，过期版本的第二发被拒：' + r2.message)
  const finalRow = ls.listRows('waterlevel').find((r) => r.id === target)
  assert(finalRow.status === '已通过', '最终只保留一个结果：已通过')
  assert(finalRow.rev === 2, '版本号推进为 2，实际 ' + finalRow.rev)

  console.log('8) 中断审核保留原因且不产生终态')
  const intId = byNo('WATE-20260903-01').row.id
  const ir = wl.mutateWaterLevel(intId, '中断审核', { reason: '上游站数据未到齐' })
  assert(ir.ok, '中断操作成功')
  const intRow = ls.listRows('waterlevel').find((r) => r.id === intId)
  assert(intRow.status === '待审核' && intRow.reviewMeta.interruptReason === '上游站数据未到齐', '回到待审核并记录中断原因')

  console.log('9) 预警阈值入口一并写入复核链路')
  const before = wl.listReviews().length
  wl.reviewWarningThresholdChange({
    configNo: 'WARN-0002', station: 'STAT-0002', monitorType: '河道水位', action: '调整阈值',
    values: { orange: '27.20' },
  })
  const reviews = wl.listReviews()
  assert(reviews.length === before + 1, '复核记录 +1')
  assert(reviews.some((r) => r.source === 'warning' && r.bizKey === 'WARN-0002'), '存在预警配置入口的复核记录')
  assert(reviews.some((r) => r.source === 'waterlevel'), '水位审核入口的复核记录也在同一链路')

  console.log('10) 历史结论兼容：旧裸格式迁移不翻转 status（独立进程）')
  const { execFileSync } = require('child_process')
  const out = execFileSync(process.execPath, [path.join(__dirname, 'test-migrate.cjs')], { encoding: 'utf8' })
  console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'))
  assert(out.includes('MIGRATE_OK'), '迁移子进程断言通过')

  console.log(`\n全部通过：${passed} 项断言`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
