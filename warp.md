# Warp 项目说明（ReCode）

本仓库是 VS Code 扩展 **ReCode - AI Code History Guard** 的代码库。

## 技能列表

本项目定义了以下技能（Skills），请根据任务类型自动启用：

| 技能 | 触发场景 | 定义文件 |
|------|----------|----------|
| **config-driven-dev** | 新功能、重构、修 bug、任何代码改动 | `.claude/skills/config-driven-dev/SKILL.md` |
| **publish** | 发布、上线、打包、推送市场 | `.claude/skills/publish/SKILL.md` |

---

## 开发约定：统一走“配置驱动开发技能”

本项目的所有开发任务（新功能、重构、修 bug）统一遵守下面的约定：

1. **默认启用技能：config-driven-dev**  
   - 技能定义文件：`.claude/skills/config-driven-dev/SKILL.md`  
   - 任何 AI/助手在帮忙写代码或设计方案前，都应先按照此技能里的原则来思考与回答。

2. **需求评审必须先问配置**  
   - 看到“加个开关”、“改行为”、“调性能”这类需求时，优先问：
     - 这个行为是否应该做成配置？
     - 配置项应该叫什么、默认值是什么、边界条件是什么？
   - 只有在确认**不需要**做成长期能力时，才允许一次性的硬编码方案。

3. **实现必须通过配置生效**  
   - 新行为通过 VS Code 的 `contributes.configuration` 或统一配置模块暴露配置项。
   - 代码中读取配置，并通过配置控制：启用/禁用、阈值、保留策略、防抖、过滤等。
   - 支持监听配置变更（如 `workspace.onDidChangeConfiguration`），尽量做到运行时生效。

4. **PR / 变更说明要提到对应配置**  
   - 在提交说明中简要列出：
     - 新增或修改的配置键名
     - 默认值
     - 对行为的影响（安全性 / 性能 / 体验）

---

## 发布约定：启用“publish”技能

当用户说“发布”、“上线”、“打包”、“publish”、“推送”等关键词时，必须启用 `publish` 技能：

1. **技能定义文件：** `.claude/skills/publish/SKILL.md`
2. **执行流程：**
   - 按照技能文件中的步骤，同时发布到 VS Code Marketplace 和 Open VSX Registry
   - 使用项目根目录下的 `.env` 文件中的 Token

---

## 在 Warp 中使用的方式

- 在 Warp 里唤起 Agent / AI 助手时，如果是本仓库：
  - **开发任务：** 自动启用 `config-driven-dev` 技能
  - **发布任务：** 自动启用 `publish` 技能
- 助手在回答时，应：
  - 先读取对应的技能文件
  - 按照技能文件中的流程和原则执行任务

> 简单说：这个仓库里，所有开发默认走 `config-driven-dev` 技能，所有发布默认走 `publish` 技能。
