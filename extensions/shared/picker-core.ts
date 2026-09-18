/**
 * picker-core — 选项式交互的纯状态机（Functional Core）。
 *
 * 无 IO、无 ANSI、不 import TUI：过滤、光标、单选/多选、分页、提交判定全在这里。
 * Shell（quiz-ui / ask-ui 等）只负责把键盘事件翻译成这里的调用，再用
 * shared/picker-view 渲染。
 */

export const PICKER_PAGE_SIZE = 8;

export type PickerOption = {
  /** 稳定标识：选择结果按 id 记录，不受过滤与分页影响。 */
  id: string;
  label: string;
  /** 机器可读值，默认等于 label（由调用方归一化时填充）。 */
  value: string;
  description?: string;
  /** 特殊行：other = 自由文本，dont-know = 诚实放弃（探针场景需要）。 */
  kind?: "option" | "other" | "dont-know";
};

export type PickerState = {
  query: string;
  /** 过滤后列表中的绝对下标（跨页保持）。 */
  cursor: number;
  /** 选择顺序 = 数组顺序。 */
  selectedIds: string[];
};

export const createPickerState = (): PickerState => ({
  query: "",
  cursor: 0,
  selectedIds: [],
});

const normalize = (text: string): string => text.trim().toLowerCase();

/** 空查询返回全部；无匹配返回空数组。 */
export const filterOptions = (
  options: PickerOption[],
  query: string,
): PickerOption[] => {
  const normalized = normalize(query);
  if (!normalized) return options;
  return options.filter((option) => {
    const haystack = `${option.label} ${option.description ?? ""}`;
    return normalize(haystack).includes(normalized);
  });
};

/** 输入查询：光标回到首行，已选内容保留。 */
export const setQuery = (state: PickerState, query: string): PickerState => ({
  ...state,
  query,
  cursor: 0,
});

/** 光标移动：夹取而不环绕，空列表停在 0。 */
export const moveCursor = (
  state: PickerState,
  delta: number,
  total: number,
): PickerState => {
  const lastIndex = Math.max(0, total - 1);
  const next = Math.min(lastIndex, Math.max(0, state.cursor + delta));
  return next === state.cursor ? state : { ...state, cursor: next };
};

/** 单选替换旧值；多选 toggle，且保持选择顺序、不产生重复项。 */
export const toggleSelection = (
  state: PickerState,
  id: string,
  multiSelect: boolean,
): PickerState => {
  if (!multiSelect) {
    const alreadyOnly =
      state.selectedIds.length === 1 && state.selectedIds[0] === id;
    return alreadyOnly ? state : { ...state, selectedIds: [id] };
  }
  const selectedIds = state.selectedIds.includes(id)
    ? state.selectedIds.filter((current) => current !== id)
    : [...state.selectedIds, id];
  return { ...state, selectedIds };
};

export const isSubmittable = (state: PickerState): boolean =>
  state.selectedIds.length > 0;

export const pageOf = (cursor: number, pageSize = PICKER_PAGE_SIZE): number =>
  pageSize <= 0 ? 0 : Math.floor(Math.max(0, cursor) / pageSize);

export const pageCount = (
  total: number,
  pageSize = PICKER_PAGE_SIZE,
): number => (pageSize <= 0 || total <= 0 ? 1 : Math.ceil(total / pageSize));

/** 分页越界夹取；末页不满时返回剩余项。 */
export const pageSlice = (
  options: PickerOption[],
  page: number,
  pageSize = PICKER_PAGE_SIZE,
): PickerOption[] => {
  const safePage = Math.min(
    Math.max(0, page),
    pageCount(options.length, pageSize) - 1,
  );
  const start = safePage * pageSize;
  return options.slice(start, start + pageSize);
};

/** 按选择顺序还原选项（id 未命中时忽略）。 */
export const resolveSelected = (
  options: PickerOption[],
  state: PickerState,
): PickerOption[] => {
  const byId = new Map(options.map((option) => [option.id, option]));
  return state.selectedIds.flatMap((id) => {
    const option = byId.get(id);
    return option ? [option] : [];
  });
};
