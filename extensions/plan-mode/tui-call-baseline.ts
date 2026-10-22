/**
 * 终端下的 `ctx.ui` 调用基线（characterization fixture）。由 `tui-parity.test.ts`
 * 生成，不要手改：
 *   PLAN_MODE_RECORD_TUI_PARITY=1 npx vitest run extensions/plan-mode/tui-parity.test.ts
 * 只有确实要让 TUI 有意变更时才重新录制；其它不一致一律按回归处理（改实现，不改基线）。
 */
import type { UiCall } from "./test-harness.js";

export const TUI_CALL_BASELINE: Record<string, UiCall[]> = {
  "session_start：Act、无 todo": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    }
  ],
  "切到 plan 模式": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Plan · Planning · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    }
  ],
  "1 个 todo（set、in_progress）": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Plan · Planning · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Plan · Waiting for review · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【Waiting for review】进行中 #1/1：实现状态机 · 更新于 刚刚</accent>",
        "已完成 0/1 · 剩余 1 项",
        "→ #1 [~] 实现状态机"
      ]
    }
  ],
  "4 个 todo：set + 完成一个": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【Act】进行中 #1/4：实现状态机 · 更新于 刚刚</accent>",
        "已完成 0/4 · 剩余 4 项",
        "→ #1 [~] 实现状态机",
        "  #2 [ ] 补充 README",
        "  #3 [ ] 补测试",
        "  #4 [ ] 提交"
      ]
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【Act】下一步 #2/4：补充 README · 更新于 刚刚</accent>",
        "已完成 1/4 · 剩余 3 项",
        "  #1 [✓] 实现状态机",
        "→ #2 [ ] 补充 README",
        "  #3 [ ] 补测试",
        "  #4 [ ] 提交"
      ]
    }
  ],
  "已批准计划跑完（completeApprovedDemoRun）": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【Act】下一步 #1/1：实现已批准任务 · 更新于 刚刚</accent>",
        "已完成 0/1 · 剩余 1 项",
        "→ #1 [ ] 实现已批准任务"
      ]
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Approved, executing · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【Approved, executing】下一步 #1/1：实现已批准任务 · 更新于 刚刚</accent>",
        "已完成 0/1 · 剩余 1 项",
        "→ #1 [ ] 实现已批准任务"
      ]
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Approved, executing · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【Approved, executing】下一步 #1/1：实现已批准任务 · 更新于 刚刚</accent>",
        "已完成 0/1 · 剩余 1 项",
        "→ #1 [ ] 实现已批准任务"
      ]
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Completed, back to Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos",
      "lines": [
        "<accent>【completed, back to Act】✅ 计划「demo」已完成 · 1/1 项任务已交付</accent>",
        "已交付：",
        "  #1 实现已批准任务"
      ]
    }
  ],
  "plan → act 切换": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Plan · Planning · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    }
  ],
  "/plan-mode status": [
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    },
    {
      "call": "setStatus",
      "key": "plan-mode"
    },
    {
      "call": "setWidget",
      "key": "plan-mode-current-mode",
      "lines": [
        "<accent>Plan Mode: Act · Act · Alt+0 toggles</accent>"
      ]
    },
    {
      "call": "setWidget",
      "key": "plan-mode-todos"
    }
  ]
};
