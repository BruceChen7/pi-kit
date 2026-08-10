<script lang="ts">
import Button from "./components/Button.svelte";

// Delegate form — worktree mode on by default, base branch selectable,
// branch name editable (validated against task/<key>-<slug> style).
let {
  taskKey,
  defaultBranch,
  onConfirm,
  onCancel,
}: {
  taskKey: string;
  defaultBranch: string;
  onConfirm: (
    instructions: string,
    worktree: boolean,
    baseBranch: string,
    branch: string,
  ) => void;
  onCancel: () => void;
} = $props();

let instructions = $state("");
let worktree = $state(true);
let baseBranch = $state("main");
let branchName = $state(initialBranchName());
let branchError = $state("");
let baseTouched = $state(false);

// The form remounts per task, so capturing the prop's initial value is intended.
function initialBranchName() {
  return defaultBranch;
}

function toggleWorktree() {
  worktree = !worktree;
  if (!baseTouched) {
    branchName = defaultBranch;
    baseTouched = true;
  }
}

function submit() {
  const name = branchName.trim();
  if (worktree) {
    if (!name) {
      branchError = "分支名称不能为空";
      return;
    }
    if (!/^task\/[a-z0-9-]+$/.test(name)) {
      branchError = "分支名须符合 task/<key>-<slug> 风格（小写字母数字和 -）";
      return;
    }
  }
  onConfirm(instructions, worktree, baseBranch, name);
}
</script>

<div class="flex flex-col gap-2.5">
  <div class="text-[12.5px] font-semibold">委托 {taskKey} 给 herdr agent</div>

  <textarea
    class="box-border w-full resize-y rounded-md border border-[#3b3f4a] bg-[#1c1f26] p-2 text-[12.5px] text-[#e5e7eb]"
    aria-label="额外指令"
    placeholder="额外指令（可选）：先跑测试再提交…"
    bind:value={instructions}
    rows="2"
  ></textarea>

  <label class="flex min-w-0 cursor-pointer items-center gap-2 pl-[72px] text-xs text-[#9ca3af]">
    <input
      class="m-0 size-3.5 shrink-0 appearance-none rounded border border-[#4b5563] bg-[#1c1f26] checked:border-indigo-500 checked:bg-indigo-500 checked:after:ml-1 checked:after:mt-px checked:after:block checked:after:h-[7px] checked:after:w-1 checked:after:rotate-45 checked:after:border-0 checked:after:border-b-2 checked:after:border-r-2 checked:after:border-solid checked:after:border-white checked:after:content-['']"
      type="checkbox"
      checked={worktree}
      onchange={toggleWorktree}
    />
    <span>在独立 git worktree 中工作</span>
  </label>

  {#if worktree}
    <div class="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2 gap-y-[3px]">
      <span class="col-start-1 text-xs text-[#9ca3af]">基于分支</span>
      <select class="task-form-control task-select task-mono" bind:value={baseBranch}>
        <option value="main">main</option>
        <option value="develop">develop</option>
        <option value="master">master</option>
      </select>
      <span class="col-start-2 text-[10.5px] text-[#4b5563]">worktree 从该分支切出</span>
    </div>
    <div class="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2 gap-y-[3px]">
      <span class="col-start-1 text-xs text-[#9ca3af]">分支名称</span>
      <input class="task-form-control task-mono" bind:value={branchName} spellcheck="false" />
      <span class="col-start-2 text-[10.5px] text-[#4b5563]">可编辑，须符合 task/&lt;key&gt;-&lt;slug&gt; 风格</span>
    </div>
    {#if branchError}
      <div class="rounded-md border border-[#4c2226] bg-[#2a1215] px-2.5 py-1.5 text-[11.5px] text-red-400">{branchError}</div>
    {/if}
  {/if}

  <div class="task-actions">
    <Button onclick={onCancel}>取消</Button>
    <Button variant="primary" onclick={submit}>确认委托</Button>
  </div>
</div>
