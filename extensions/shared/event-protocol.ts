/**
 * 跨扩展事件信封（ADR-0002 D5）。
 *
 * `pi.events` 只有 channel 名，没有版本、序号与生命周期。两个扩展各自升级时，
 * 老消费者会把新负载读成垃圾，或者把重放的事件当成新事件。这里给每个事件加一层
 * 薄信封：
 *
 *   { protocol, instanceId, sequence, payload }
 *
 * - `protocol` 变了就是破坏性变更，消费者显式拒绝，而不是猜字段。
 * - `instanceId` 标识一次"发布方生命周期"（reload / 会话替换后变化）。
 * - `sequence` 只在同一 instanceId 内递增，**跨 instanceId 不可比较**。
 *
 * 裸负载（没有信封）按 legacy 接受一版，方便渐进迁移。
 */

export const EVENT_PROTOCOL = 1;

export type EventEnvelope<T> = {
  protocol: number;
  /** 知道就带上：同一宿主上多个会话并存时，消费方据此丢掉别的会话的事件。 */
  sessionId?: string;
  instanceId: string;
  sequence: number;
  payload: T;
};

export const wrapEvent = <T>(
  instanceId: string,
  sequence: number,
  payload: T,
  sessionId?: string,
): EventEnvelope<T> => ({
  protocol: EVENT_PROTOCOL,
  ...(sessionId === undefined ? {} : { sessionId }),
  instanceId,
  sequence,
  payload,
});

export type ReadEvent<T> = {
  payload: T;
  /** 没有信封的旧负载：照常处理，但不参与序号去重。 */
  legacy: boolean;
  sessionId?: string;
  instanceId?: string;
  sequence?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * 读一个事件。信封形状不对（protocol 不匹配、字段缺失）就返回 undefined ——
 * 消费者据此忽略它，而不是按猜的字段继续跑。
 */
export const readEvent = <T>(value: unknown): ReadEvent<T> | undefined => {
  if (!isRecord(value)) return undefined;

  const protocol = value.protocol;
  if (protocol === undefined) {
    return { payload: value as T, legacy: true };
  }
  if (protocol !== EVENT_PROTOCOL) return undefined;
  if (typeof value.instanceId !== "string" || value.instanceId === "") {
    return undefined;
  }
  if (typeof value.sequence !== "number" || !Number.isFinite(value.sequence)) {
    return undefined;
  }
  return {
    payload: value.payload as T,
    legacy: false,
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
    instanceId: value.instanceId,
    sequence: value.sequence,
  };
};

export type SeenEvent = {
  instanceId: string;
  sequence: number;
};

/**
 * 同一 instanceId 内只接受更大的序号；换了 instanceId 就重置（新生命周期从 1 起）。
 * legacy 事件永远接受：它没有序号可比，丢掉反而会丢状态。
 */
export const isFreshEvent = (
  seen: SeenEvent | undefined,
  event: ReadEvent<unknown>,
): boolean => {
  if (event.legacy) return true;
  const instanceId = event.instanceId;
  const sequence = event.sequence;
  if (instanceId === undefined || sequence === undefined) return true;
  if (seen === undefined || seen.instanceId !== instanceId) return true;
  return sequence > seen.sequence;
};

/** 记住刚接受的事件；legacy 事件不更新状态。 */
export const seenAfter = (
  seen: SeenEvent | undefined,
  event: ReadEvent<unknown>,
): SeenEvent | undefined => {
  if (event.legacy) return seen;
  if (event.instanceId === undefined || event.sequence === undefined) {
    return seen;
  }
  return { instanceId: event.instanceId, sequence: event.sequence };
};

/**
 * 发布方的序号来源。`instanceId` 每次扩展加载生成一次，所以重启后的序号不会
 * 与上一次的比较。
 */
export type EventPublisher = {
  instanceId: string;
  next: <T>(payload: T) => EventEnvelope<T>;
};

export const createPublisher = (
  instanceId: string,
  sessionId?: string,
): EventPublisher => {
  let sequence = 0;
  return {
    instanceId,
    next: <T>(payload: T): EventEnvelope<T> => {
      sequence += 1;
      return wrapEvent(instanceId, sequence, payload, sessionId);
    },
  };
};

// ── 快照与主动索取 ────────────────────────────────────────────────────────
//
// 逐条 delta 有两个问题：中途 attach 的消费者永远补不齐历史，重启后的第一条
// delta 会被当成全量。所以状态类 channel 定成"快照"语义：每次发出的都是**全量**
// （完整替换上一份），任何消费者先发一次索取，就能拿到当前状态。

/** 索取当前快照的请求；比状态 channel 多一些约束，所以单独一份形状。 */
export type SnapshotRequest = {
  protocol: number;
  type: "state-request";
};

export const snapshotRequest = (): SnapshotRequest => ({
  protocol: EVENT_PROTOCOL,
  type: "state-request",
});

export const isSnapshotRequest = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return value.protocol === EVENT_PROTOCOL && value.type === "state-request";
};

/** 状态 channel 对应的索取 channel：`<channel>:request`。 */
export const snapshotRequestChannel = (channel: string): string =>
  `${channel}:request`;

/**
 * 快照内容的共同外壳：`kind: "snapshot"` 表示"这份替换上一份"，
 * `empty` 表示"我现在不持有任何状态"（与"没消息"区分开）。
 */
export type SnapshotEnvelope<T> = {
  kind: "snapshot";
  empty: boolean;
  entries: T[];
};
