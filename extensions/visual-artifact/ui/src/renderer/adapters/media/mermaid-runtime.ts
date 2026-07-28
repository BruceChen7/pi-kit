export type MermaidAppTheme = string;

export type MermaidRuntimeApi = {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown> | unknown;
  render(id: string, code: string): Promise<{ svg: string }> | { svg: string };
};

const MERMAID_THEME_VARIABLES: Record<string, Record<string, string>> = {
  dark: {
    background: "#0f172a",
    primaryColor: "#1e293b",
    primaryTextColor: "#f1f5f9",
    primaryBorderColor: "#475569",
    secondaryColor: "#334155",
    secondaryTextColor: "#e2e8f0",
    tertiaryColor: "#111827",
    tertiaryTextColor: "#e2e8f0",
    lineColor: "#94a3b8",
    textColor: "#f1f5f9",
    mainBkg: "#1e293b",
    nodeBorder: "#475569",
    clusterBkg: "#1f2937",
    clusterBorder: "#475569",
    edgeLabelBackground: "#0f172a",
  },
  light: {
    background: "#f8fafc",
    primaryColor: "#ffffff",
    primaryTextColor: "#0f172a",
    primaryBorderColor: "#cbd5e1",
    secondaryColor: "#f1f5f9",
    secondaryTextColor: "#1e293b",
    tertiaryColor: "#e2e8f0",
    tertiaryTextColor: "#1e293b",
    lineColor: "#475569",
    textColor: "#0f172a",
    mainBkg: "#ffffff",
    nodeBorder: "#cbd5e1",
    clusterBkg: "#f8fafc",
    clusterBorder: "#cbd5e1",
    edgeLabelBackground: "#ffffff",
  },
} as const;

export type MermaidRenderInput = {
  id: string;
  theme: MermaidAppTheme;
  definition: string;
  fontFamily?: string;
};

let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

export function getMermaidTheme(theme: MermaidAppTheme): "base" {
  void theme;
  return "base";
}

export function getMermaidThemeVariables(
  theme: MermaidAppTheme,
): Record<string, string> {
  return MERMAID_THEME_VARIABLES[theme] ?? MERMAID_THEME_VARIABLES.dark;
}

export function getMermaidRenderConfig(
  theme: MermaidAppTheme,
  fontFamily = "var(--va-font-sans)",
): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme: getMermaidTheme(theme),
    securityLevel: "strict",
    fontFamily,
    themeVariables: getMermaidThemeVariables(theme),
  };
}

export function normalizeMermaidDefinition(definition: string): string {
  return definition
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

async function runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Mermaid render timed out after ${ms}ms`));
    }, ms);

    fn().then(
      (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export function enqueueMermaidRender<T>(
  renderFn: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      try {
        const result = await runWithTimeout(renderFn, 10000);
        resolve(result);
        return result;
      } catch (error) {
        reject(error);
        return undefined;
      }
    };

    mermaidRenderQueue = mermaidRenderQueue.then(run, run);
  });
}

export async function renderMermaidDiagram(
  mermaid: MermaidRuntimeApi,
  input: MermaidRenderInput,
): Promise<string> {
  const _mermaidTheme = getMermaidTheme(input.theme);
  const normalizedDefinition = normalizeMermaidDefinition(input.definition);

  mermaid.initialize(
    getMermaidRenderConfig(
      input.theme,
      input.fontFamily ?? "var(--va-font-sans)",
    ),
  );

  await mermaid.parse(normalizedDefinition);
  const rendered = await mermaid.render(
    `${input.id}-${input.theme}`,
    normalizedDefinition,
  );
  return rendered.svg;
}

export async function loadMermaidRuntime(): Promise<MermaidRuntimeApi> {
  const mermaid = (await import("mermaid")).default;
  return mermaid as unknown as MermaidRuntimeApi;
}
