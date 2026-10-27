import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Functional core for the poteto router.
 *
 * Everything here is value-in / value-out: no fs, no clock, no randomness, no
 * session state. The shell in `index.ts` injects `readText` / `exists` and owns
 * every side effect.
 */

export const routeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  useWhen: Type.String({ minLength: 1 }),
  phase: Type.Optional(Type.Boolean()),
  firstSteps: Type.Array(Type.String({ minLength: 1 })),
  optionalSteps: Type.Array(Type.String({ minLength: 1 })),
  playbookHints: Type.Array(
    Type.Object({
      when: Type.String({ minLength: 1 }),
      playbook: Type.String({ minLength: 1 }),
    }),
  ),
  steps: Type.Array(Type.String({ minLength: 1 })),
  closingSteps: Type.Array(Type.String({ minLength: 1 })),
  gates: Type.Array(Type.String({ minLength: 1 })),
});

export const modeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  useWhen: Type.String({ minLength: 1 }),
  playbook: Type.String({ minLength: 1 }),
});

export const catalogSchema = Type.Object({
  version: Type.Number(),
  routes: Type.Array(routeSchema, { minItems: 1 }),
  modes: Type.Array(modeSchema),
});

export type Route = Static<typeof routeSchema>;
export type Mode = Static<typeof modeSchema>;
export type Catalog = Static<typeof catalogSchema>;

export type CatalogValidation =
  | { ok: true; catalog: Catalog }
  | { ok: false; problems: string[] };

export function validateCatalog(raw: unknown): CatalogValidation {
  if (!Value.Check(catalogSchema as TSchema, raw)) {
    const problems = [...Value.Errors(catalogSchema as TSchema, raw)]
      .slice(0, 20)
      .map((error) => `${error.path || "/"} ${error.message}`);
    return { ok: false, problems };
  }

  const catalog = raw as Catalog;
  const problems: string[] = [];

  const duplicateRoutes = duplicates(catalog.routes.map((route) => route.id));
  for (const id of duplicateRoutes) {
    problems.push(`duplicate route id: ${id}`);
  }

  const duplicateModes = duplicates(catalog.modes.map((mode) => mode.id));
  for (const id of duplicateModes) {
    problems.push(`duplicate mode id: ${id}`);
  }

  const routeIds = new Set(catalog.routes.map((route) => route.id));
  for (const mode of catalog.modes) {
    if (routeIds.has(mode.id)) {
      problems.push(`mode id collides with route id: ${mode.id}`);
    }
  }

  for (const route of catalog.routes) {
    if (route.firstSteps.length === 0 && route.optionalSteps.length === 0) {
      problems.push(
        `${route.id}: needs at least one first step or optional step`,
      );
    }
    if (route.steps.length === 0) {
      problems.push(`${route.id}: steps must not be empty`);
    }
  }

  return problems.length === 0
    ? { ok: true, catalog }
    : { ok: false, problems };
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

export type ResolvedStep = {
  id: string;
  path: string;
  /** `disable-model-invocation: true`: the skill is not advertised to the model. */
  hidden: boolean;
};

export type StepResolution =
  | { ok: true; step: ResolvedStep }
  | { ok: false; id: string; tried: string[] };

export type ResolveStepInput = {
  id: string;
  roots: string[];
  /** Returns the file text, or null when the path does not exist. */
  readText: (path: string) => string | null;
};

/** Resolve `id` to `<root>/<id>/SKILL.md` in root order. First hit wins. */
export function resolveStep(input: ResolveStepInput): StepResolution {
  const tried: string[] = [];
  for (const root of input.roots) {
    const path = `${root}/${input.id}/SKILL.md`;
    const text = input.readText(path);
    if (text !== null) {
      return {
        ok: true,
        step: { id: input.id, path, hidden: isHiddenSkill(text) },
      };
    }
    tried.push(path);
  }
  return { ok: false, id: input.id, tried };
}

/** `disable-model-invocation: true` inside the YAML frontmatter block. */
export function isHiddenSkill(skillText: string): boolean {
  const frontmatter = frontmatterOf(skillText);
  if (frontmatter === null) return false;
  return /^disable-model-invocation:\s*true\s*$/m.test(frontmatter);
}

function frontmatterOf(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match ? match[1] : null;
}

export type ResolveCatalogInput = {
  roots: string[];
  exists: (path: string) => boolean;
};

/** `<root>/poteto-playbooks/routes.json`, first root that has it. */
export function resolveCatalogPath(input: ResolveCatalogInput): string | null {
  for (const root of input.roots) {
    const path = `${root}/poteto-playbooks/routes.json`;
    if (input.exists(path)) return path;
  }
  return null;
}

export function findRoute(catalog: Catalog, id: string): Route | undefined {
  return catalog.routes.find((route) => route.id === id);
}

export function findMode(catalog: Catalog, id: string): Mode | undefined {
  return catalog.modes.find((mode) => mode.id === id);
}

export type PlaybookText = { name: string; text: string };

/** Playbook names a route needs: its own hints, then the mode's single playbook. */
export function routePlaybooks(route: Route, mode: Mode | null): string[] {
  const names = route.playbookHints.map((hint) => hint.playbook);
  if (mode) names.push(mode.playbook);
  return names;
}

export type RenderRouteInput = {
  route: Route;
  mode: Mode | null;
  firstSteps: ResolvedStep[];
  optionalSteps: ResolvedStep[];
  closingSteps: ResolvedStep[];
  playbooks: PlaybookText[];
  /** Steps the catalog names but disk does not have; reported, not fatal. */
  warnings: string[];
};

/** The model-facing payload: todo seed first, then paths, then playbook bodies. */
export function renderRouteResult(input: RenderRouteInput): string {
  const { route, mode } = input;
  const lines: string[] = [];

  lines.push(`route: ${route.id}（${route.label}）`);
  if (mode) lines.push(`mode: ${mode.id}（${mode.label}）`);
  lines.push("");
  lines.push(`这一步的判据：${route.useWhen}`);
  lines.push("");
  lines.push(`把下面这几项按顺序抄进 todo（与工具 details.todo 一致）：`);
  for (const line of todoSeed(route, mode)) lines.push(`- ${line}`);
  lines.push("");

  if (input.firstSteps.length > 0) {
    lines.push("先做这些 skill（用 read 打开绝对路径，不要凭名字猜）：");
    for (const step of input.firstSteps) lines.push(formatStep(step));
    lines.push("");
  }

  if (input.optionalSteps.length > 0) {
    lines.push("适用时再做：");
    for (const step of input.optionalSteps) lines.push(formatStep(step));
    lines.push("");
  }

  if (route.playbookHints.length > 0) {
    lines.push("playbook 选择：");
    for (const hint of route.playbookHints) {
      lines.push(`- ${hint.when} → playbooks/${hint.playbook}.md`);
    }
    lines.push("");
  }

  if (input.closingSteps.length > 0) {
    lines.push("收尾：");
    for (const step of input.closingSteps) lines.push(formatStep(step));
    lines.push("");
  }

  if (route.gates.length > 0) {
    lines.push("闸门（违反就停下来说明）：");
    for (const gate of route.gates) lines.push(`- ${gate}`);
    lines.push("");
  }

  if (input.warnings.length > 0) {
    lines.push("警告（不影响本次 route，但要自己去盘上确认）：");
    for (const warning of input.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  for (const playbook of input.playbooks) {
    lines.push(`### playbook: ${playbook.name}`);
    lines.push("");
    lines.push(playbook.text.trim());
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatStep(step: ResolvedStep): string {
  const suffix = step.hidden
    ? "（disable-model-invocation: true，描述不可见，只能按路径读）"
    : "";
  return `- ${step.id} → ${step.path}${suffix}`;
}

/** Todo lines to copy verbatim. First line is always `route: <id>`. */
export function todoSeed(route: Route, mode: Mode | null): string[] {
  const seed = [`route: ${route.id}`];
  if (mode) seed.push(`mode: ${mode.id}`);
  for (const step of route.steps) seed.push(step);
  for (const id of route.closingSteps) seed.push(`/skill:${id}`);
  return seed;
}

export type GateInput = {
  armed: boolean;
  routed: boolean;
  toolName: string;
};

/** Per-session poteto state. Two flags, no persistence. */
export type RouteState = {
  armed: boolean;
  routed: boolean;
  routeId?: string;
};

/**
 * A `/poteto` input starts a task, so any earlier route is stale. Without this
 * reset a second `/poteto` in the same session inherits `routed: true` and is
 * never gated again.
 */
export function armForNewTask(): RouteState {
  return { armed: true, routed: false };
}

/**
 * Any `route_task` call opens the gate, including a failed one. The gate exists
 * to force the call, not to police its outcome; left closed on failure, a
 * wiring problem would block `edit` / `write` for the rest of the session.
 */
export function recordRouteAttempt(
  state: RouteState,
  routeId: string,
): RouteState {
  return { ...state, routed: true, routeId };
}

export type GateDecision = { block: true; reason: string };

const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Only an armed, not-yet-routed session is gated, and only on the tools that
 * start changing files. `bash` stays open on purpose: recon and tests need it.
 */
export function decideGate(input: GateInput): GateDecision | undefined {
  if (!input.armed || input.routed) return undefined;
  if (!MUTATING_TOOLS.has(input.toolName)) return undefined;
  return {
    block: true,
    reason:
      "poteto-route: 先调 route_task 确定 route，它会给你 steps、playbook 和收尾 skill。改文件之前先把 route 写进 todo。",
  };
}
