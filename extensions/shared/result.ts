export type OkResult<T> = {
  ok: true;
  value: T;
};

export type ErrResult<E = string> = {
  ok: false;
  message: E;
};

export type Result<T, E = string> = OkResult<T> | ErrResult<E>;

type ResultLike = {
  ok: boolean;
};

export function isOk<T extends ResultLike>(
  result: T,
): result is Extract<T, { ok: true }> {
  return result.ok === true;
}

export function isErr<T extends ResultLike>(
  result: T,
): result is Extract<T, { ok: false }> {
  return result.ok === false;
}
