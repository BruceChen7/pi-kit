<script lang="ts">
import type { TasksDb } from "./bridge.ts";
import Button from "./components/Button.svelte";

type Task = TasksDb["tasks"][number];

let {
  task,
  descendantCount,
  commentCount,
  onCancel,
  onConfirm,
}: {
  task: Task;
  descendantCount: number;
  commentCount: number;
  onCancel: () => void;
  onConfirm: () => void;
} = $props();
</script>

<div
  class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onCancel();
  }}
>
  <div
    class="w-full max-w-[430px] overflow-hidden rounded-[13px] border border-[#434854] bg-[#191c24] shadow-[0_22px_60px_rgba(0,0,0,.55)]"
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-task-title"
  >
    <div class="flex items-start justify-between px-[18px] pb-3 pt-[18px]">
      <h2 class="m-0 text-base font-semibold" id="delete-task-title">删除 Backlog 任务</h2>
      <button
        class="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[#9ca3af] hover:bg-[#292d38] hover:text-[#e5e7eb]"
        type="button"
        aria-label="关闭"
        onclick={onCancel}
      >×</button>
    </div>
    <div class="px-[18px] pb-[18px] text-[#9ca3af]">
      <div>即将删除以下任务：</div>
      <div class="my-3 rounded-lg bg-[#222630] p-[11px] text-[#e5e7eb]">
        <code class="text-[11px] text-indigo-300">{task.key}</code>
        <span class="pl-2">{task.title}</span>
      </div>
      <div>此操作会同时删除：</div>
      <ul class="my-3 rounded-lg border border-red-900 bg-[#2a1215] py-2.5 pl-[30px] pr-3 text-red-200">
        {#if descendantCount > 0}
          <li>{descendantCount} 个子任务</li>
        {/if}
        <li>{commentCount} 条评论</li>
      </ul>
      <div class="text-xs text-red-300">此操作不可恢复。</div>
    </div>
    <footer class="flex justify-end gap-2 border-t border-[#2d3039] px-[18px] py-[14px]">
      <Button onclick={onCancel}>取消</Button>
      <Button variant="danger" onclick={onConfirm}>删除任务</Button>
    </footer>
  </div>
</div>
