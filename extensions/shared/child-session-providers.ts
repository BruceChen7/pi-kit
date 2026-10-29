/**
 * 子会话的 provider 注册转交。
 *
 * pi-kit 的子会话（subagent、btw）都用 `noExtensions: true` 建：扩展发现被关掉，
 * 于是「只由扩展注册的 provider」在子会话里不存在注册。cc-switch 的本地网关就是这样
 * 一个 provider，子会话继承到的只是父会话的 model 对象，认证查询会直接报
 * `No API key found for "<provider>"`。
 *
 * 这里只做转交：从父会话的 ModelRegistry 取出子会话要用的 provider 注册，再原样重放进
 * 子会话的 loader。`noExtensions` 的隔离边界不动，provider 注册是唯一的例外。
 */

import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";

export type ProviderRegistration = {
  name: string;
  config: ProviderConfig;
};

/**
 * 子会话要用到的 provider，父会话有注册就带上。父会话没注册（内置 provider 靠
 * models.json / auth.json 认证）就跳过，让子会话按自己的配置解析。
 */
export function collectProviderRegistrations(input: {
  providers: readonly (string | undefined)[];
  getConfig: (provider: string) => ProviderConfig | undefined;
}): ProviderRegistration[] {
  const seen = new Set<string>();
  const registrations: ProviderRegistration[] = [];
  for (const provider of input.providers) {
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    const config = input.getConfig(provider);
    if (config) registrations.push({ name: provider, config });
  }
  return registrations;
}

/** 把父会话的 provider 注册重放给子会话；认证仍由子会话自己的 runtime 完成。 */
export const createProviderForwardingExtension =
  (registrations: readonly ProviderRegistration[]) =>
  (pi: ExtensionAPI): void => {
    for (const { name, config } of registrations) {
      pi.registerProvider(name, config);
    }
  };
