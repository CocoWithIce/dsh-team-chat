/**
 * E15 复核指纹守卫 —— lib/p2/review-guard.js
 *
 * t96 · P2 Slice 2（设计稿 v0.7 §10 E15，reviewer2 提出、t89 冻结）：
 * 「review 任务 claim 时宿主自动快照被审文件指纹（file→sha256）；update_task 完成时
 * 自动比对，不匹配即警告」——把「复核窗口零修订」从纪律承诺升级为机制。
 *
 * 落点（与设计的两个触发点一一对应）：
 *   1. claim 快照：executeMemberTool（B′ 通道）成功认领 kind='review' 任务时，
 *      对 task.inScope 文件集快照（readFile 边界注入；宿主装配时接 fs 服务）；
 *   2. 完成比对：updateCaptainTask / executeMemberTool 结算 completed 时自动比对，
 *      不匹配 → 警告载荷（不阻断——设计语义是「警告」，处置人工）。
 *
 * 存储位置（诚实披露）：P1 store 记录 schema 冻结（lib/state 不在本任务 in-scope），
 * 指纹集存宿主侧 sidecar（按 taskId 键控，与 attemptCache 同款宿主态）；
 * 「入任务记录」的完整形态待 P1 schema 扩展任务承载（基线 §9 登记遗留）。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 单文件指纹。 */
export function fingerprintFile(file, readFile = readFileSync) {
  const buf = readFile(file)
  return { file, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length }
}

/**
 * 创建一个 E15 守卫实例（宿主侧 sidecar，按 taskId 键控）。
 * @param {object} [options]
 * @param {(file: string) => Buffer} [options.readFile] - 文件读边界（默认 node:fs）。
 */
export function createReviewGuard(options = {}) {
  const readFile = options.readFile ?? readFileSync
  /** @type {Map<string, {files: {file,sha256,bytes}[], errors: unknown[]}>} */
  const snapshots = new Map()

  return {
    /** 是否持有某任务的快照。 */
    has(taskId) {
      return snapshots.has(taskId)
    },
    /** 读取快照（不改状态）。 */
    snapshotOf(taskId) {
      return snapshots.get(taskId)
    },
    /**
     * claim 时快照被审文件集（task.inScope）。
     * @returns {{ok: boolean, count?: number, files?: object[], errors?: unknown[], reason?}}
     */
    snapshotFor(task) {
      const files = Array.isArray(task?.inScope) ? task.inScope : []
      if (files.length === 0) {
        return { ok: false, reason: 'no-in-scope-files' }
      }
      const out = []
      const errors = []
      for (const file of files) {
        try {
          out.push(fingerprintFile(file, readFile))
        } catch (e) {
          errors.push({ file, error: String(e) })
        }
      }
      const record = { files: out, errors }
      snapshots.set(task.id, record)
      return { ok: out.length > 0, count: out.length, files: out, errors }
    },
    /**
     * 完成时比对当前文件 vs claim 快照。**不匹配 = 警告**（设计语义，不阻断）。
     * @returns {{match: boolean, reason?, changed?: object[], compared?: number}}
     */
    compareFor(task) {
      const snap = snapshots.get(task.id)
      if (snap === undefined) {
        return { match: false, reason: 'e15-no-snapshot', compared: 0 }
      }
      const changed = []
      let compared = 0
      for (const before of snap.files) {
        compared += 1
        let after
        try {
          after = fingerprintFile(before.file, readFile)
        } catch (e) {
          changed.push({ file: before.file, kind: 'unreadable', before: before.sha256, error: String(e) })
          continue
        }
        if (after.sha256 !== before.sha256 || after.bytes !== before.bytes) {
          changed.push({ file: before.file, kind: 'modified', before: before.sha256, after: after.sha256 })
        }
      }
      const match = changed.length === 0
      // 比对即消费（一次性守卫；重开复核需重新 claim 触发新快照）。
      snapshots.delete(task.id)
      return { match, compared, ...(match ? {} : { changed }) }
    },
    /** 释放某任务快照（任务被 superseded/failed 等非完成出口时宿主调用）。 */
    release(taskId) {
      snapshots.delete(taskId)
    },
  }
}
