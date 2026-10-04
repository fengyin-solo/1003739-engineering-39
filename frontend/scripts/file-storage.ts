/**
 * Node 侧的 JSON 文件存储适配器：让同一套发布引擎既能在浏览器 localStorage 跑，
 * 也能在命令行/CI 里对着 .release-data/ 下的「数据库文件」跑。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { StorageAdapter } from '../src/release/types'

export class JsonFileStorage implements StorageAdapter {
  private indexPath: string

  constructor(dataDir: string) {
    this.indexPath = resolve(dataDir, 'index.json')
    if (!existsSync(dirname(this.indexPath))) {
      mkdirSync(dirname(this.indexPath), { recursive: true })
    }
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, JSON.stringify({}, null, 2))
    }
  }

  private index(): Record<string, string> {
    return JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, string>
  }

  private saveIndex(index: Record<string, string>): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2))
  }

  getItem(key: string): string | null {
    const file = this.index()[key]
    if (!file) {
      return null
    }
    const path = resolve(dirname(this.indexPath), file)
    if (!existsSync(path)) {
      return null
    }
    return readFileSync(path, 'utf8')
  }

  setItem(key: string, value: string): void {
    const index = this.index()
    const file = `${encodeURIComponent(key)}.json`
    writeFileSync(resolve(dirname(this.indexPath), file), value)
    index[key] = file
    this.saveIndex(index)
  }

  removeItem(key: string): void {
    const index = this.index()
    const file = index[key]
    if (file) {
      rmSync(resolve(dirname(this.indexPath), file), { force: true })
      delete index[key]
      this.saveIndex(index)
    }
  }

  /** 清空全部「表」并重置索引（只用于本地发布数据库的 reset）。 */
  clear(): void {
    for (const file of Object.values(this.index())) {
      rmSync(resolve(dirname(this.indexPath), file), { force: true })
    }
    this.saveIndex({})
  }

  get dataDir(): string {
    return dirname(this.indexPath)
  }
}
