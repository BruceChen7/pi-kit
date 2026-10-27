import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  armForNewTask,
  type Catalog,
  decideGate,
  findMode,
  findRoute,
  type Mode,
  type PlaybookText,
  type ResolvedStep,
  type RouteState,
  recordRouteAttempt,
  renderRouteResult,
  resolveCatalogPath,
  resolveStep,
  routePlaybooks,
  todoSeed,
  validateCatalog,
} from "./catalog.ts";

const TOOL_NAME = "route_task";
const COMMAND_NAME = "poteto-route";

/** `/poteto` at the start of the input; `/poteto-route` must not arm. */
const POTETO_INPUT = /^\/poteto(?:\s|$)/;

export function isPotetoInput(text: string): boolean {
  return POTETO_INPUT.test(text);
}

const sessions = new Map<string, RouteState>();

function stateFor(sessionId: string): RouteState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: RouteState = { armed: false, routed: false };
  sessions.set(sessionId, created);
  return created;
}

function sessionIdOf(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as
    | { getSessionId?: () => string }
    | undefined;
  return manager?.getSessionId?.() ?? ctx.cwd;
}

/** Skill roots, in the same order `prompts/poteto.md` §0 documents. */
export function skillRoots(cwd: string): string[] {
  return [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".agents", "me-skills"),
  ];
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export type LoadedCatalog = {
  catalog: Catalog;
  catalogPath: string;
  baseDir: string;
};

/** Shell-side IO for the catalog. Returns a problem string instead of throwing. */
export function loadCatalog(cwd: string): LoadedCatalog | { problem: string } {
  const roots = skillRoots(cwd);
  const catalogPath = resolveCatalogPath({ roots, exists: existsSync });
  if (catalogPath === null) {
    return {
      problem: `找不到 poteto-playbooks/routes.json，查过：${roots.join("、")}`,
    };
  }

  const text = readText(catalogPath);
  if (text === null) {
    return { problem: `routes.json 读不出来：${catalogPath}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      problem: `routes.json 不是合法 JSON：${catalogPath}（${String(error)}）`,
    };
  }

  const validated = validateCatalog(raw);
  if (!validated.ok) {
    return {
      problem: `routes.json 不合法：${validated.problems.join("; ")}`,
    };
  }

  return {
    catalog: validated.catalog,
    catalogPath,
    baseDir: dirname(catalogPath),
  };
}

function resolveSteps(
  ids: string[],
  roots: string[],
): { steps: ResolvedStep[]; problems: string[] } {
  const steps: ResolvedStep[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const resolved = resolveStep({ id, roots, readText });
    if (resolved.ok) {
      steps.push(resolved.step);
    } else {
      problems.push(`${id} 找不到，查过：${resolved.tried.join("、")}`);
    }
  }
  return { steps, problems };
}

export function readPlaybooks(
  baseDir: string,
  names: string[],
): {
  playbooks: PlaybookText[];
  problems: string[];
} {
  const playbooks: PlaybookText[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const path = join(baseDir, "playbooks", `${name}.md`);
    const text = readText(path);
    if (text === null) {
      problems.push(`playbook 缺失：${path}`);
      continue;
    }
    playbooks.push({ name, text });
  }
  return { playbooks, problems };
}

export function buildRouteParam(
  catalog: Catalog | null,
): ReturnType<typeof Type.String> | ReturnType<typeof Type.Union> {
  if (catalog === null || catalog.routes.length === 0) {
    return Type.String({
      description:
        "类型 id。catalog 尚未加载，先跑 /poteto-route status 看可用 id。",
      minLength: 1,
    });
  }
  return Type.Union(
    catalog.routes.map((route) => Type.Literal(route.id)),
    {
      description: catalog.routes
        .map((route) => `${route.id}（${route.label}）：${route.useWhen}`)
        .join("\n"),
    },
  );
}

export function buildModeParam(
  catalog: Catalog | null,
): ReturnType<typeof Type.Union> | ReturnType<typeof Type.String> {
  const ids = catalog?.modes.map((mode) => mode.id) ?? [];
  if (ids.length === 0) {
    return Type.Optional(
      Type.String({
        description: "可选：长跑或停机模式 id。",
        minLength: 1,
      }),
    );
  }
  return Type.Optional(
    Type.Union(
      ids.map((id) => Type.Literal(id)),
      {
        description: catalog?.modes
          .map((mode) => `${mode.id}（${mode.label}）：${mode.useWhen}`)
          .join("\n"),
      },
    ),
  );
}

function describeRoutes(catalog: Catalog | null): string {
  if (catalog === null) return "catalog 未加载";
  return catalog.routes.map((route) => route.id).join(",");
}

export default function potetoRoute(pi: ExtensionAPI): void {
  // Resolved once and kept: the advertised route enum and `execute` must agree,
  // and re-reading routes.json per call would let them drift. A failed resolve
  // is not cached, so the first `execute` with a usable cwd retries.
  let cached: LoadedCatalog | null = null;
  const catalogFor = (cwd: string): LoadedCatalog | { problem: string } => {
    if (cached) return cached;
    const loaded = loadCatalog(cwd);
    if (!("problem" in loaded)) cached = loaded;
    return loaded;
  };

  const startup = catalogFor(process.cwd());
  const catalogForParams = "catalog" in startup ? startup.catalog : null;

  pi.registerTool({
    name: TOOL_NAME,
    label: "Poteto route",
    description:
      "Deterministic wiring for the poteto route table. Call it before changing files: you pass the route id you judged, it returns the steps to copy into the todo list, absolute SKILL.md paths for every skill the route names, the playbook body, and the gates. It does not classify for you.",
    promptSnippet: `route_task: 传入你判定的 route id，拿回 steps、skill 绝对路径、playbook 正文与闸门。可用 id：${describeRoutes(catalogForParams)}`,
    parameters: Type.Object({
      route: buildRouteParam(catalogForParams),
      mode: buildModeParam(catalogForParams),
      task: Type.Optional(
        Type.String({
          description: "原始任务文本，只用于日志与状态，不参与判定。",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as {
        route: string;
        mode?: string;
        task?: string;
      };
      const cwd = ctx.cwd;
      const sessionId = sessionIdOf(ctx);
      sessions.set(
        sessionId,
        recordRouteAttempt(stateFor(sessionId), input.route),
      );

      const loaded = catalogFor(cwd);
      if ("problem" in loaded) {
        return {
          content: [{ type: "text" as const, text: loaded.problem }],
          isError: true,
          details: { route: input.route, ok: false },
        };
      }

      const { catalog, baseDir, catalogPath } = loaded;
      const route = findRoute(catalog, input.route);
      if (!route) {
        return {
          content: [
            {
              type: "text" as const,
              text: `未知 route: ${input.route}。可用：${describeRoutes(catalog)}`,
            },
          ],
          isError: true,
          details: { route: input.route, ok: false },
        };
      }

      const mode: Mode | null = input.mode
        ? (findMode(catalog, input.mode) ?? null)
        : null;
      if (input.mode && !mode) {
        return {
          content: [
            {
              type: "text" as const,
              text: `未知 mode: ${input.mode}。可用：${catalog.modes.map((entry) => entry.id).join(",")}`,
            },
          ],
          isError: true,
          details: { route: route.id, ok: false },
        };
      }

      const roots = skillRoots(cwd);
      const first = resolveSteps(route.firstSteps, roots);
      const optional = resolveSteps(route.optionalSteps, roots);
      const closing = resolveSteps(route.closingSteps, roots);
      const playbooks = readPlaybooks(baseDir, routePlaybooks(route, mode));

      const warnings = [
        ...optional.problems,
        ...closing.problems,
        ...playbooks.problems,
      ];

      if (first.problems.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `route ${route.id} 的必需 skill 装不上，先修 catalog 或跑 make install-skills：\n- ${first.problems.join("\n- ")}`,
            },
          ],
          isError: true,
          details: {
            route: route.id,
            ok: false,
            problems: first.problems,
            catalogPath,
          },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: renderRouteResult({
              route,
              mode,
              firstSteps: first.steps,
              optionalSteps: optional.steps,
              closingSteps: closing.steps,
              playbooks: playbooks.playbooks,
              warnings,
            }),
          },
        ],
        details: {
          ok: true,
          route: route.id,
          mode: mode?.id ?? null,
          todo: todoSeed(route, mode),
          firstSteps: first.steps,
          closingSteps: closing.steps,
          warnings,
          catalogPath,
        },
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: `Report poteto-route state: idle or armed, plus the catalog route ids`,
    handler: async (args: string, ctx: ExtensionContext) => {
      const argument = args.trim();
      if (argument === "reset") {
        sessions.delete(sessionIdOf(ctx));
        ctx.ui.notify(`poteto-route: reset, edit / write 不再被拦`, "info");
        return;
      }
      if (argument && argument !== "status") {
        ctx.ui.notify(`用法：/${COMMAND_NAME} status | reset`, "warning");
        return;
      }

      const loaded = catalogFor(ctx.cwd);
      if ("problem" in loaded) {
        ctx.ui.notify(`poteto-route: ${loaded.problem}`, "warning");
        return;
      }

      const state = stateFor(sessionIdOf(ctx));
      const phase = state.armed
        ? state.routed
          ? `armed, routed=${state.routeId ?? "?"}`
          : "armed, waiting for route_task"
        : "idle";
      ctx.ui.notify(
        `poteto-route: ${phase} routes: ${describeRoutes(loaded.catalog)}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessions.delete(sessionIdOf(ctx));
  });

  pi.on("input", async (event, ctx) => {
    if (!isPotetoInput(event.text)) return { action: "continue" as const };
    sessions.set(sessionIdOf(ctx), armForNewTask());
    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = stateFor(sessionIdOf(ctx));
    return decideGate({
      armed: state.armed,
      routed: state.routed,
      toolName: event.toolName,
    });
  });
}
