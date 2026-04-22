import { isErr } from "../../shared/result.js";
import {
  type FeatureWorkflowSetupCliOptions,
  type FeatureWorkflowSetupParseResult,
  type FeatureWorkflowSetupTarget,
  SETUP_TARGETS,
  trimToNull,
  uniqueStrings,
} from "./shared.js";

const SETUP_TARGET_ALIASES: Record<string, FeatureWorkflowSetupTarget> = {
  settings: "settings",
  config: "settings",
  gitignore: "gitignore",
  "git-ignore": "gitignore",
  ignore: "gitignore",
  worktreeinclude: "worktreeinclude",
  "worktree-include": "worktreeinclude",
  include: "worktreeinclude",
  script: "hook-script",
  "hook-script": "hook-script",
  hook: "hook-script",
  wt: "wt-toml",
  "wt-toml": "wt-toml",
  "wt.toml": "wt-toml",
  "wt-user-config": "wt-user-config",
  "user-config": "wt-user-config",
  "wt-config": "wt-user-config",
  worktrunk: "wt-user-config",
};

const SETUP_TARGET_METADATA: Record<
  FeatureWorkflowSetupTarget,
  { label: string; description: string }
> = {
  settings: {
    label: ".pi/third_extension_settings.json",
    description: "Enable ignoredSync defaults and add missing profile rules.",
  },
  gitignore: {
    label: ".gitignore",
    description:
      "Ensure .pi/ and .config/wt.toml are ignored for setup-managed artifacts.",
  },
  worktreeinclude: {
    label: ".worktreeinclude",
    description: "Add recommended copy-managed ignored entries.",
  },
  "hook-script": {
    label: "$HOME/.pi/pi-feature-workflow-links.sh",
    description: "Generate the reusable symlink hook script.",
  },
  "wt-toml": {
    label: ".config/wt.toml",
    description: "Install/update a managed pre-start hook block.",
  },
  "wt-user-config": {
    label: "~/.config/worktrunk/config.toml",
    description:
      "Set the recommended global worktree-path template for slug-only worktree directories.",
  },
};

const SETUP_TARGETS_DISPLAY = SETUP_TARGETS.join(", ");

export const FEATURE_WORKFLOW_SETUP_USAGE =
  "Usage: /feature-setup [profile] [--only=<targets>] [--skip=<targets>] [--yes]";
export const FEATURE_WORKFLOW_SETUP_TARGETS = [...SETUP_TARGETS];

function parseTargetList(raw: string) {
  const values = uniqueStrings(
    raw.split(",").map((entry) => entry.toLowerCase()),
  );
  const targets: FeatureWorkflowSetupTarget[] = [];

  for (const value of values) {
    const target = SETUP_TARGET_ALIASES[value];
    if (!target) {
      return {
        ok: false as const,
        message: `Unknown target '${value}'. Supported targets: ${SETUP_TARGETS_DISPLAY}.`,
      };
    }

    if (!targets.includes(target)) {
      targets.push(target);
    }
  }

  return {
    ok: true as const,
    value: targets,
  };
}

type ParsedOptionValue = {
  optionValue: string;
  consumed: number;
};

function parseOptionValue(token: string, args: string[], index: number) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    const inlineValue = token.slice(equalsIndex + 1).trim();
    if (!inlineValue) {
      return {
        ok: false as const,
        message: `Missing value for option '${token.slice(0, equalsIndex)}'.`,
      };
    }

    return {
      ok: true as const,
      value: {
        optionValue: inlineValue,
        consumed: 1,
      } satisfies ParsedOptionValue,
    };
  }

  const next = trimToNull(args[index + 1]);
  if (!next) {
    return {
      ok: false as const,
      message: `Missing value for option '${token}'.`,
    };
  }

  return {
    ok: true as const,
    value: {
      optionValue: next,
      consumed: 2,
    } satisfies ParsedOptionValue,
  };
}

export function parseFeatureWorkflowSetupArgs(
  args: string[],
): FeatureWorkflowSetupParseResult {
  let profileId: string | null = null;
  let onlyTargets: FeatureWorkflowSetupTarget[] | null = null;
  const skipTargets: FeatureWorkflowSetupTarget[] = [];
  let yes = false;

  for (let index = 0; index < args.length; ) {
    const token = trimToNull(args[index]);
    if (!token) {
      index += 1;
      continue;
    }

    if (token === "--yes") {
      yes = true;
      index += 1;
      continue;
    }

    if (token === "--profile" || token.startsWith("--profile=")) {
      const parsedValue = parseOptionValue(token, args, index);
      if (isErr(parsedValue)) {
        return {
          ok: false,
          message: parsedValue.message,
        };
      }

      profileId = parsedValue.value.optionValue;
      index += parsedValue.value.consumed;
      continue;
    }

    if (token === "--only" || token.startsWith("--only=")) {
      const parsedValue = parseOptionValue(token, args, index);
      if (isErr(parsedValue)) {
        return {
          ok: false,
          message: parsedValue.message,
        };
      }

      const parsedTargets = parseTargetList(parsedValue.value.optionValue);
      if (isErr(parsedTargets)) {
        return {
          ok: false,
          message: parsedTargets.message,
        };
      }

      onlyTargets = parsedTargets.value;
      index += parsedValue.value.consumed;
      continue;
    }

    if (token === "--skip" || token.startsWith("--skip=")) {
      const parsedValue = parseOptionValue(token, args, index);
      if (isErr(parsedValue)) {
        return {
          ok: false,
          message: parsedValue.message,
        };
      }

      const parsedTargets = parseTargetList(parsedValue.value.optionValue);
      if (isErr(parsedTargets)) {
        return {
          ok: false,
          message: parsedTargets.message,
        };
      }

      for (const target of parsedTargets.value) {
        if (!skipTargets.includes(target)) {
          skipTargets.push(target);
        }
      }

      index += parsedValue.value.consumed;
      continue;
    }

    if (token.startsWith("--")) {
      return {
        ok: false,
        message: `Unknown option '${token}'.`,
      };
    }

    if (profileId) {
      return {
        ok: false,
        message: `Unexpected extra argument '${token}'. Profile is already '${profileId}'.`,
      };
    }

    profileId = token;
    index += 1;
  }

  return {
    ok: true,
    value: {
      profileId,
      onlyTargets,
      skipTargets,
      yes,
    } satisfies FeatureWorkflowSetupCliOptions,
  };
}

export function resolveFeatureWorkflowSetupTargets(
  options: Pick<FeatureWorkflowSetupCliOptions, "onlyTargets" | "skipTargets">,
): FeatureWorkflowSetupTarget[] {
  const seed = options.onlyTargets ?? SETUP_TARGETS;
  const selected = new Set<FeatureWorkflowSetupTarget>(seed);
  for (const target of options.skipTargets) {
    selected.delete(target);
  }

  if (selected.has("wt-toml")) {
    selected.add("hook-script");
  }

  if (selected.has("hook-script")) {
    selected.add("gitignore");
  }

  return SETUP_TARGETS.filter((target) => selected.has(target));
}

export function getFeatureWorkflowSetupTargetMeta(
  target: FeatureWorkflowSetupTarget,
): { label: string; description: string } {
  return {
    ...SETUP_TARGET_METADATA[target],
  };
}
