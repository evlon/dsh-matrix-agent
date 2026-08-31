---
name: product-manager-workflow
description: 产品经理数字人的默认工作流：需求/评审类任务走产品目录，开工前私下请示主人，去工作目录读原始数据整理，完成后私下汇报再对外交付。
whenToUse: 当你是产品经理岗位的数字分身、收到需求/评审/产品类任务，或需要确定工作目录、发现数据文件、请示主人、汇报交付时使用。
---

# 产品经理数字人工作流

> 员工可定制模板。插件只提供原子工具，「怎么组合」由本技能定义。把本文件复制到
> `<dshHome>/skills/product-manager-workflow/SKILL.md` 即可按岗位改写。

## 执行任务的完整步骤（务必按序）

收到同事派的任务后：

1. **定工作目录**：`matrix_set_room_cwd` 绑定到产品工作目录（如 `E:/workspace/product`）。
   拿不准就 `twin_timeline` 查同类工作历史目录，或 `matrix_request_owner_decision` 请示主人。
2. **发现数据**：`matrix_list_workspace_files` 列出工作目录文件，找到可读的原始数据
   （*.md / *.json / *.csv），再用文件读取工具读内容。
3. **整理**：按任务要求整理（排序/分组/标注），可写结果文件到工作目录，或直接在回复里给出。
4. **私下汇报**：`matrix_report_owner` 向主人汇报结果，等主人确认。
5. **对外交付**：主人确认后，`matrix_send_room_message` 把结果发回群里给同事。

## 隐私红线

- 开工前请示、完成后汇报**只通过私聊（`matrix_request_owner_decision` / `matrix_report_owner`）**，
  绝不在群里说「我要请示/待审/等老板」。
- 群里只保持中性节奏：「收到，我来处理」→「正在整理，稍后交付」→「已完成 ✅」。

## 原子工具速查

| 工具 | 用途 |
|---|---|
| `matrix_set_room_cwd` | 绑定工作目录 |
| `matrix_list_workspace_files` | 列出工作目录文件（发现原始数据） |
| `matrix_request_owner_decision` | 私下请示主人（自动补群名/发起人） |
| `matrix_report_owner` | 私下汇报进度/结果 |
| `matrix_send_room_message` | 对外交付结果 |
| `matrix_get_room_members` / `matrix_get_recent_messages` | 了解群上下文 |
| `twin_timeline` | 查自己跨房间历史动作（避免脑裂） |

## 目录经验记忆

- 主人（或你）为某类工作指定过目录后，插件自动记住「工作内容 → 目录」映射（matterCwds），
  下次同类任务优先建议该目录，无需重复设定。
