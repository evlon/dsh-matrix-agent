/**
 * 任务流转场景（占位）：同事发任务 → 数字人请示老板 → 老板批准 → 执行 → 交付回群。
 *
 * ⚠️ 前置条件：数字人侧需开启 `digitalTwinMode=true`（秘书编排）才能完整跑通
 * （数字人才会走"开工请示/交付确认"流程）。当前若未开启，场景可跑但断言可能失败。
 * 实现要点（后续完善）：
 * - 同事在群里给数字人发任务（@ 数字人）
 * - 数字人应私聊老板请示（twin sent dm to owner）
 * - 老板批准后数字人执行并交付回群
 * - 断言：数字人最终回复 / 任务被理解
 */
import type { TestRoomDef } from '../orchestrator.js'
import type { ColleaguePersona } from '../ai-colleague.js'

/** 生成任务流转场景（占位实现：基本对话 + 任务类断言）。 */
export function buildTaskFlowScenario(colleagueUserIds: string[]): TestRoomDef[] {
  const persona = (index: number, displayName: string, role: string, goal: string): ColleaguePersona => ({
    userId: colleagueUserIds[index % colleagueUserIds.length],
    displayName,
    role,
    goal,
  })
  const goal = '在群里给数字人派一个明确的任务（如"帮我整理一份上周的 bug 清单"），观察它是否理解并回应，必要时追问进度。'
  return [
    {
      name: '任务流转测试群',
      colleagues: [
        persona(0, '张三', '研发工程师，负责派发开发任务', goal),
        persona(1, '李四', '产品经理，会补充任务需求背景', goal),
      ],
      goal,
      asserts: [
        { id: 'reply', label: '数字人响应了任务', kind: 'twin-replied' },
        { id: 'count', label: '任务对话产生足够消息（≥4 条）', kind: 'message-count', target: 4 },
        // 秘书编排断言：数字人应私聊老板请示（需 twinModeRoomPrefix 匹配测试房间 + owner 指向老板账号）。
        { id: 'twin-sent-dm', label: '数字人私聊老板请示开工（秘书编排）', kind: 'twin-sent-dm' },
        { id: 'boss-approved', label: '老板自动批准开工', kind: 'boss-approved' },
        { id: 'task-delivered', label: '任务完成并交付（确认或交付回群）', kind: 'task-delivered' },
      ],
    },
  ]
}
