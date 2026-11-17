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
  legacy: boolean;
  sessionId?: string;
  instanceId?: string;
  sequence?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

export const snapshotRequestChannel = (channel: string): string =>
  `${channel}:request`;

export type SnapshotEnvelope<T> = {
  kind: "snapshot";
  empty: boolean;
  entries: T[];
};
