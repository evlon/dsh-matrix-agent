/**
 * 分身工作台 Typert Remote Service：把运行时镜像（时间线/收件箱/任务看板/岗位看板）
 * 与命令通道（清时间线/主人决策/岗位切换）通过 Typert RPC 暴露给 Client（DSH Web）。
 *
 * 0.1.7 里 settings namespace 只能写 volatile 用户配置字段，运行时数据（非用户配置）
 * 不能塞进 settings。正确通道是 Typert RPC（ctx.remote）：Host 侧用 @Remote 装饰器
 * 标记方法 + TypertRemoteService 绑定，Gateway 经 source-mode（src-json codec）自动发现
 * 端点；Client 侧 $mount 手写 TYPERT_REMOTE 描述符后经 ctx.remote.<namespace>.<method>() 调用。
 *
 * 设计取舍：
 * - 读镜像用 unary 方法返回最新快照（src-json，纯 JSON 安全值），Client 侧轮询拉取；
 * - 写命令用 unary 方法（fire-and-forget 语义由 Host 内部处理，返回 void）；
 * - 暂不做 Host→Client 事件推送（需 registerRemoteEvents 装配 + API_REMOTE_FORWARDED_EVENTS
 *   名单，独立插件无此装配），Client 轮询 3s 一次已足够覆盖「命令执行后镜像刷新」。
 *
 * @module dsh-matrix-agent/workbench
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { TimelineOps, OwnerDecisionOps, JobSwitchOps, OwnerInboxSnapshot, TaskBoardSnapshot, JobBoardSnapshot } from './settings.js'

/** 时间线快照（镜像，Host→Client）。entries 为元数据数组（不落原文）。 */
export interface TimelineSnapshot {
  entries: unknown[]
  updatedAt: number
}

/** 空时间线快照。 */
export function emptyTimelineSnapshot(): TimelineSnapshot {
  return { entries: [], updatedAt: 0 }
}

/**
 * 工作台后端服务：把运行时镜像（时间线/收件箱/任务看板/岗位看板）经 Typert RPC 暴露给
 * Client，并把 Client 发来的命令转发给 bridge。
 *
 * 镜像数据源是 MatrixBridge（经 settingsHandle.updateXxx 写入缓存）。本服务不自己持缓存，
 * 而是持有 settingsHandle 的 getter 引用——单一数据源，避免两处缓存不同步。
 * 命令分发回调由 index.ts 在 bridge 创建后注入（wireHandlers）。
 */
export class MatrixWorkbenchService extends TypertRemoteService {
  /** 镜像 getter（从 settingsHandle 读最新缓存）。 */
  private getTimelineRef: () => TimelineSnapshot
  private getOwnerInboxRef: () => OwnerInboxSnapshot
  private getTaskBoardRef: () => TaskBoardSnapshot
  private getJobBoardRef: () => JobBoardSnapshot
  /** 命令分发回调（由 index.ts 注入，转发给 MatrixBridge）。 */
  private onTimelineOps?: (ops: TimelineOps) => void
  private onOwnerDecisionOps?: (ops: OwnerDecisionOps) => void
  private onJobSwitchOps?: (ops: JobSwitchOps) => void | Promise<void>

  constructor(
    ctx: Context,
    getters: {
      getTimeline: () => TimelineSnapshot
      getOwnerInbox: () => OwnerInboxSnapshot
      getTaskBoard: () => TaskBoardSnapshot
      getJobBoard: () => JobBoardSnapshot
    },
  ) {
    super(ctx, 'matrixWorkbench')
    this.getTimelineRef = getters.getTimeline
    this.getOwnerInboxRef = getters.getOwnerInbox
    this.getTaskBoardRef = getters.getTaskBoard
    this.getJobBoardRef = getters.getJobBoard
  }

  /** 注入命令分发回调（index.ts 在 bridge 创建后调用，把命令转给 bridge）。 */
  wireHandlers(handlers: {
    onTimelineOps: (ops: TimelineOps) => void
    onOwnerDecisionOps: (ops: OwnerDecisionOps) => void
    onJobSwitchOps: (ops: JobSwitchOps) => void | Promise<void>
  }): void {
    this.onTimelineOps = handlers.onTimelineOps
    this.onOwnerDecisionOps = handlers.onOwnerDecisionOps
    this.onJobSwitchOps = handlers.onJobSwitchOps
  }

  /** —— 读镜像（Host→Client，unary）—— */

  /** 读自我时间线快照（仅元数据）。 */
  @Remote
  getTimeline(): TimelineSnapshot {
    return this.getTimelineRef()
  }

  /** 读主人收件箱快照。 */
  @Remote
  getOwnerInbox(): OwnerInboxSnapshot {
    return this.getOwnerInboxRef()
  }

  /** 读任务看板快照。 */
  @Remote
  getTaskBoard(): TaskBoardSnapshot {
    return this.getTaskBoardRef()
  }

  /** 读岗位看板快照。 */
  @Remote
  getJobBoard(): JobBoardSnapshot {
    return this.getJobBoardRef()
  }

  /** —— 写命令（Client→Host，unary）—— */

  /** 清空/删除时间线条目。 */
  @Remote
  handleTimelineOps(ops: TimelineOps): void {
    this.onTimelineOps?.(ops)
  }

  /** 主人决策（批准/拒绝请示、交付/拒绝汇报、同意/拒绝入群）。 */
  @Remote
  handleOwnerDecisionOps(ops: OwnerDecisionOps): void {
    this.onOwnerDecisionOps?.(ops)
  }

  /** 切换岗位（空 roomId=全局默认，非空=某房间）。 */
  @Remote
  async handleJobSwitchOps(ops: JobSwitchOps): Promise<void> {
    await this.onJobSwitchOps?.(ops)
  }
}
