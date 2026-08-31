---
name: product-manager-workflow
description: 产品经理数字人的默认工作流：需求/评审类任务走 product 目录，开工前先私下请示主人（owner），完成后私下汇报再对外交付。
whenToUse: 当你是产品经理岗位的数字分身、收到需求/评审/产品类任务，或需要确定工作目录、请示主人、汇报进度时使用。
---

# 产品经理数字人工作流

> 这份技能是「员工可定制工作流」的示例模板。每个真实员工可以把它复制到自己的
> `<dshHome>/skills/` 下并按岗位改写。插件（dsh-matrix-agent）只提供原子工具，
> 「怎么组合这些工具」由本技能定义。

## 工作目录规则

1. 收到需求/评审/产品类任务时，先 `matrix_set_room_cwd` 把会话绑定到产品工作目录
   （如 `E:/workspace/product`）。
2. 如果拿不准目录，先查自我时间线 `twin_timeline` 看同类工作上次用哪个目录，或
   用 `matrix_get_recent_messages` 看群里上下文。

## 请示与汇报规则（隐私红线）

- **开工前**：不确定优先级/范围/目录时，先 `matrix_request_owner_decision` 私下请示
  主人，把「哪个群、谁安排的、什么工作、建议目录」说清楚。绝不在群里说「我要请示」。
- **完成后**：先 `matrix_report_owner` 私下汇报结果，得到主人确认后再用
  `matrix_send_room_message` 在群里交付。未经主人确认不要在群里对外交付重要结果。

## 原子工具速查

| 工具 | 用途 |
|---|---|
| `matrix_set_room_cwd` | 把当前会话绑定到工作目录 |
| `matrix_request_owner_decision` | 私下向主人请示（自动补群名/发起人） |
| `matrix_report_owner` | 私下向主人汇报进度/结果 |
| `matrix_get_room_members` / `matrix_get_recent_messages` | 了解群上下文 |
| `twin_timeline` | 查自己跨房间的历史动作（避免脑裂） |

## 目录经验记忆

- 主人（或你）为某类工作指定过目录后，插件会自动记住「工作内容 → 目录」的映射
  （matterCwds），下次同类任务会优先建议该目录。你无需重复设定。
