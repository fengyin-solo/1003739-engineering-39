import { driveRelease } from './pipeline'
import type { ReleaseBatch, ReleaseOptions, StepKey } from './types'
import { STEP_NAMES } from './types'

export type RetryOutcome = {
  batch: ReleaseBatch
  phases: { status: ReleaseBatch['status']; failedAt?: StepKey }[]
}

/**
 * 按需求执行「任一步失败 → 整批回退 → 从失败步骤重试」：
 * 第一次按注入故障演练回退，第二次去掉注入重放，整条线最终成功。
 * 注入只在首轮生效；不传注入点时就是一次性正常发布。
 */
export function runReleaseWithRetry(options: ReleaseOptions): RetryOutcome {
  const phases: RetryOutcome['phases'] = []
  const first = driveRelease(options)
  phases.push({ status: first.status, failedAt: first.failedAt })
  if (first.status === 'succeeded') {
    return { batch: first, phases }
  }
  if (options.autoRetry === false) {
    return { batch: first, phases }
  }
  // 第二轮：同一个 appVersion 复用同一批次文档，attempt+1，从失败步骤重试。
  const retry: ReleaseOptions = {
    ...options,
    injectFailureAt: undefined,
    now: options.now,
  }
  const second = driveRelease(retry)
  phases.push({ status: second.status, failedAt: second.failedAt })
  return { batch: second, phases }
}

export function describeFailure(batch: ReleaseBatch | null): string {
  if (!batch || !batch.failedAt) {
    return ''
  }
  return `${STEP_NAMES[batch.failedAt]}：${batch.steps[batch.failedAt].error ?? '未知错误'}`
}
