export type MermaidAppTheme = string;

export type MermaidRuntimeApi = {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown> | unknown;
  render(id: string, code: string): Promise<{ svg: string }> | { svg: string };
};

const MERMAID_THEME_VARIABLES: Record<string, Record<string, string>> = {
  light: {
    background: "#faf9f5",
    primaryColor: "#ffffff",
    primaryTextColor: "#141413",
    primaryBorderColor: "#d1cfc5",
    secondaryColor: "#f0eee6",
    secondaryTextColor: "#3d3d3a",
    tertiaryColor: "#e6e3da",
    tertiaryTextColor: "#3d3d3a",
    lineColor: "#6b6a63",
    textColor: "#141413",
    mainBkg: "#ffffff",
    nodeBorder: "#d1cfc5",
    clusterBkg: "#faf9f5",
    clusterBorder: "#d1cfc5",
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
  return MERMAID_THEME_VARIABLES[theme] ?? MERMAID_THEME_VARIABLES.light;
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

function getContrastingTextColor(fill: string): string | null {
  const compactHex = fill.slice(1);
  const hex =
    compactHex.length === 3
      ? compactHex
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : compactHex;

  if (!/^[\da-f]{6}$/i.test(hex)) return null;

  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];

  return luminance > 0.42 ? "#0f172a" : "#f8fafc";
}

function ensureClassDefTextContrast(line: string): string {
  if (!/^\s*classDef\b/i.test(line)) return line;
  if (/(?:^|,)\s*color\s*:/i.test(line)) return line;

  const fill = line.match(/(?:^|[,\s])fill\s*:\s*(#[\da-f]{3,6})\b/i)?.[1];
  if (!fill) return line;

  const color = getContrastingTextColor(fill);
  if (!color) return line;

  const semicolonIndex = line.lastIndexOf(";");
  if (semicolonIndex < 0) return `${line},color:${color}`;

  return `${line.slice(0, semicolonIndex)},color:${color}${line.slice(semicolonIndex)}`;
}

export function normalizeMermaidDefinition(definition: string): string {
  return definition
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .split("\n")
    .map(ensureClassDefTextContrast)
    .join("\n");
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
