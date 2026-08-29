/**
 * 场景注册表：所有可运行的测试场景。
 * 每个场景 = 一个 build 函数，输入同事 userId 列表，产出 TestRoomDef[]。
 */
import type { TestRoomDef } from '../orchestrator.js'
import { buildBasicChatScenario } from './basic-chat.js'
import { buildTaskFlowScenario } from './task-flow.js'

export interface ScenarioDef {
  id: string
  name: string
  description: string
  build: (colleagueUserIds: string[]) => TestRoomDef[]
}

/** 注册的所有场景。 */
export const SCENARIOS: Record<string, ScenarioDef> = {
  'basic-chat': {
    id: 'basic-chat',
    name: '基本对话',
    description: '研发群 + 产品群，AI 同事与数字人多轮工作讨论（验证基础回复与上下文理解）',
    build: buildBasicChatScenario,
  },
  'task-flow': {
    id: 'task-flow',
    name: '任务流转',
    description: '同事在群里给数字人派任务，观察其理解/响应（完整请示/交付流程需数字人开启 digitalTwinMode）',
    build: buildTaskFlowScenario,
  },
}

/** 场景列表（按注册顺序）。 */
export function listScenarios(): ScenarioDef[] {
  return Object.values(SCENARIOS)
}

/** 按 id 取场景；不存在返回 undefined。 */
export function getScenario(id: string): ScenarioDef | undefined {
  return SCENARIOS[id]
}
