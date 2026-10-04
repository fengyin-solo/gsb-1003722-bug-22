// 迁移兼容子进程：预置 v1 裸格式 localStorage，触发加载，验证历史结论不被翻转。
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
  const out = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', sourcefile: file })
  const module = { exports: {} }
  cache.set(file, module)
  const localRequire = (dep) => {
    if (dep.startsWith('@/')) return loadTs(dep)
    if (dep.startsWith('.')) return loadTs(path.resolve(path.dirname(file), dep))
    return require(dep)
  }
  new Function('require', 'module', 'exports', out.code)(localRequire, module, module.exports)
  return module.exports
}

const mem = new Map()
mem.set('hydrology-monitor-station:entries', JSON.stringify({
  waterlevel: [{
    id: 999, status: '已通过', pending: false, abnormal: false,
    记录编号: 'OLD-1', 站点编号: 'STAT-OLD', 观测时间: '2026-08-01 08:00',
    当前水位: '20.0', 警戒水位: '21.0', 保证水位: '22.0', 水位变幅: '0.1',
  }],
}))
global.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  },
}

const ls = loadTs('@/data/local-store')
const wl = loadTs('@/data/water-level')

const rows = ls.listRows('waterlevel')
const old = rows.find((r) => r.id === 999)
if (!old) throw new Error('旧记录丢失')
if (old.status !== '已通过') throw new Error('历史 status 被翻转')
if (old.rev !== 1) throw new Error('旧记录未补 rev=1')
if (rows.filter((r) => r.id !== 999).length < 3) throw new Error('种子新记录未合并')
const stored = JSON.parse(mem.get('hydrology-monitor-station:entries'))
if (stored.version !== 2) throw new Error('未升级到 schema v2')

// 旧记录数值完整，领域判定正常，但历史结论「已通过」原样保留
const view = wl.listWaterLevels().find((v) => v.row.id === 999)
if (view.grade !== 'normal') throw new Error('旧完整记录应判定 normal，实际 ' + view.grade)

console.log('✓ v1 旧记录 status=已通过 原样保留，补齐 rev，种子新记录追加，schema 升到 v2')
console.log('MIGRATE_OK')
