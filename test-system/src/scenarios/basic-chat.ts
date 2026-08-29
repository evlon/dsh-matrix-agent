/**
 * MVP 场景：基本对话。
 * 两个房间（研发群 / 产品讨论群），各 2 个同事，轮流与数字人聊工作。
 * 测试目标：数字人能正常回复、理解上下文。
 */
import type { ColleaguePersona } from '../ai-colleague.js'
import type { TestRoomDef } from '../orchestrator.js'

/** 同事角色库：displayName + role 描述（userId 运行时与配置账号对应）。 */
export const COLLEAGUE_ROLES: Record<string, { displayName: string; role: string }> = {
  zhang: { displayName: '张三', role: '研发工程师，技术直接，喜欢追问细节和进度' },
  li: { displayName: '李四', role: '产品经理，关注需求背景和用户价值，习惯先澄清需求' },
  wang: { displayName: '王五', role: '测试工程师，细心严谨，会验证边界情况' },
  zhao: { displayName: '赵六', role: '项目经理，看进度和风险，喜欢要排期' },
}

/** 生成测试房间（同事 userId 从配置账号按序分配）。 */
export function buildBasicChatScenario(colleagueUserIds: string[]): TestRoomDef[] {
  const byRole = (roleKey: string, index: number): ColleaguePersona => {
    const meta = COLLEAGUE_ROLES[roleKey]
    return {
      userId: colleagueUserIds[index % colleagueUserIds.length],
      displayName: meta.displayName,
      role: meta.role,
      goal: '',
    }
  }
  const goal1 = '和数字人聊研发工作：问它今天的任务、讨论一个技术问题、确认它能否理解上下文。'
  const goal2 = '和数字人讨论产品需求：提出一个需求场景、追问细节、确认它是否理解。'
  return [
    {
      name: '研发讨论群',
      colleagues: [
        { ...byRole('zhang', 0), goal: goal1 },
        { ...byRole('li', 1), goal: goal1 },
      ],
      goal: goal1,
      asserts: [
        { id: 'reply', label: '数字人回复了同事的提问', kind: 'twin-replied' },
        { id: 'count', label: '房间产生足够对话（≥4 条消息）', kind: 'message-count', target: 4 },
      ],
    },
    {
      name: '产品讨论群',
      colleagues: [
        { ...byRole('wang', 2), goal: goal2 },
        { ...byRole('zhao', 3), goal: goal2 },
      ],
      goal: goal2,
      asserts: [
        { id: 'reply', label: '数字人回复了同事的提问', kind: 'twin-replied' },
        { id: 'count', label: '房间产生足够对话（≥4 条消息）', kind: 'message-count', target: 4 },
      ],
    },
  ]
}
