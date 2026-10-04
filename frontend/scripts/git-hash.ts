import { execFileSync } from 'node:child_process'

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 读取当前源码指纹。子进程在极少数环境（容器/沙箱、或被构建工具转译加载时）
 * 会间歇性返回 128，因此做有限重试并配合退避；真的不是 git 仓库时返回固定占位，
 * 保证发布记录仍有指纹字段。
 */
export function gitShortHash(length = 12): string {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return execFileSync('git', ['rev-parse', `--short=${length}`, 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
    } catch {
      sleepSync(120 * (attempt + 1))
    }
  }
  return 'nogit000000'
}
