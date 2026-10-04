import { createWaterService } from './service'

/** 浏览器环境单例：三个界面共用同一份取数 / 复核服务 */
export const waterService = createWaterService({
  storage: window.localStorage,
})
