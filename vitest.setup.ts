import { beforeEach } from "vitest";
import { resetGuardPipeline } from "./extensions/shared/guard-pipeline.ts";

/**
 * 用例的宿主档案由用例自己决定，不由跑测试的那个 shell 决定。
 *
 * `resolveUiHostProfile()` 把环境变量 `PI_KIT_UI_HOST` 当**逃生口**（见
 * `extensions/shared/ui-host.ts`），而真机上是有人设它的：安卓壳设 `android`、pi-web 设
 * `pi-web`。于是一个人一边跑着 pi、一边在本仓库跑 `npm test`，plan-mode / tutor /
 * plannotator-auto / prompt-clarify 这些用例就会按**另一个宿主**的契约去断言 ——
 * 实测 34 条红、而代码一个字没改（`env -u PI_KIT_UI_HOST npx vitest run` 全绿即证）。
 *
 * 要测这个逃生口的用例自己设：`process.env.PI_KIT_UI_HOST = "android"`
 * （见 `extensions/notify/notify.test.ts`），所以这里删掉不影响它们。
 */
delete process.env.PI_KIT_UI_HOST;

/**
 * 护栏阶段注册表是进程级单例（真机上一个进程只有一个 pi）。用例之间会互相
 * 污染：一个文件注册的 guard 会在另一个文件里照样生效。每条用例开始前清空，
 * 让每个文件只看得见自己注册的阶段。
 */
beforeEach(() => {
  resetGuardPipeline();
});
