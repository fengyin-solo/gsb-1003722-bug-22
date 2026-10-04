<template>
  <section class="review-panel">
    <header class="review-head">
      <div>
        <h3>复核记录</h3>
        <p class="page-desc">水位审核与预警阈值配置两个入口写入同一条复核链路，只保留每个来源的最新结论。</p>
      </div>
      <div class="review-filter">
        <label class="filter-item">
          <span>来源</span>
          <select v-model="sourceFilter">
            <option value="">全部入口</option>
            <option value="waterlevel">水位审核</option>
            <option value="warning">预警阈值配置</option>
          </select>
        </label>
        <button class="btn" type="button" @click="reload">刷新</button>
      </div>
    </header>
    <table class="data-table">
      <thead>
        <tr>
          <th>入口</th><th>对象</th><th>站点</th><th>动作</th><th>结论</th>
          <th>说明</th><th>复核人</th><th>时间</th><th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in shown" :key="item.id">
          <td><span class="entry-tag" :class="item.source">{{ item.sourceLabel }}</span></td>
          <td>{{ item.title }}</td>
          <td>{{ item.station }}</td>
          <td>{{ item.action }}</td>
          <td>{{ item.conclusion }}</td>
          <td class="review-detail">{{ item.detail }}</td>
          <td>{{ item.reviewer }}</td>
          <td>{{ item.at }}</td>
          <td>
            <span class="grade-badge" :class="item.status === '已复核' ? 'normal' : 'warning'">{{ item.status }}</span>
          </td>
        </tr>
        <tr v-if="!shown.length">
          <td colspan="9" class="empty-state">
            暂无复核记录：水位「提交审核/确认通过/标记异常/重新校验」与预警阈值「发布生效/调整阈值」都会在此留痕
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listReviews } from '@/data/water-level'
import type { ReviewEntry } from '@/data/types'

const props = defineProps<{ source?: 'waterlevel' | 'warning' }>()

const records = ref<ReviewEntry[]>([])
const sourceFilter = ref(props.source ?? '')

function reload() {
  records.value = listReviews()
}

const shown = computed(() => {
  const target = sourceFilter.value || props.source || ''
  const filtered = target ? records.value.filter((item) => item.source === target) : records.value
  return filtered
})

onMounted(reload)
defineExpose({ reload })
</script>

<style scoped>
.review-panel { margin-top: 16px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.review-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.review-head h3 { margin: 0; font-size: 15px; }
.review-filter { display: flex; gap: 8px; align-items: flex-end; }
.review-detail { max-width: 320px; color: var(--muted); }
.entry-tag { border-radius: 999px; padding: 2px 8px; font-size: 12px; }
.entry-tag.waterlevel { background: #e8f0fe; color: #1f6feb; }
.entry-tag.warning { background: #fef3e2; color: #b54708; }
</style>
