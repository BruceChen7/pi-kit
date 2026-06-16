/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: sanitizer intentionally detects control characters. */
/* biome-ignore-all lint/suspicious/noExplicitAny: GitLab API and pi JSON event payloads are intentionally dynamic at this adapter boundary. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  asTextResult,
  formatDirectoryEntries,
  formatNumberedFileContent,
  globMatches,
  MAX_PATCH_CHARS,
  normalizePath,
  sanitizeParamValue,
  toolErrorResult,
  truncateInline,
  validateFilePattern,
  validateSearchPattern,
} from "./shared.js";

type GitLabProject = {
  host: string;
  fullPath: string;
  encodedPath: string;
};

// ---- Project parsing ----

export function parseGitLabProject(project: string): GitLabProject {
  let raw = project.trim();
  if (!raw) throw new Error("GitLab project is required");

  let host = "gitlab.com";
  if (raw.includes("://")) {
    const u = new URL(raw);
    if (!u.hostname)
      throw new Error("Invalid GitLab project URL: missing host");
    host = u.hostname;
    raw = u.pathname;
  }

  if (/[\x00-\x1F\x7F]/.test(raw) || /[\x00-\x1F\x7F]/.test(host)) {
    throw new Error("Invalid GitLab project: contains control characters");
  }

  const fullPath = raw.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `Invalid GitLab project: expected group/project, got "${project}"`,
    );
  }

  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid GitLab project: path traversal is not allowed");
  }

  return {
    host,
    fullPath: parts.join("/"),
    encodedPath: encodeURIComponent(parts.join("/")),
  };
}

// ---- glab CLI API ----

export async function glabApi(
  pi: ExtensionAPI,
  host: string,
  endpoint: string,
  options?: {
    method?: string;
    params?: Record<string, string | number | boolean | undefined>;
    signal?: AbortSignal;
    raw?: boolean;
    paginate?: boolean;
  },
): Promise<any> {
  if (!host.trim() || /\s/.test(host) || /[\x00-\x1F\x7F]/.test(host)) {
    throw new Error("Invalid GitLab host");
  }

  if (/\s/.test(endpoint) || /[\x00-\x1F\x7F]/.test(endpoint)) {
    throw new Error("Invalid glab api endpoint");
  }

  const method = (options?.method ?? "GET").toUpperCase();
  const params = options?.params ?? {};
  const query = new URLSearchParams();
  const fieldParams: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const sanitized = sanitizeParamValue(key, String(value));

    if (method === "GET") {
      query.append(key, sanitized);
    } else {
      fieldParams.push(`${key}=${sanitized}`);
    }
  }

  const endpointWithQuery =
    query.size > 0 ? `${endpoint}?${query.toString()}` : endpoint;
  const args: string[] = [
    "api",
    "--hostname",
    host,
    endpointWithQuery,
    "--method",
    method,
  ];

  for (const field of fieldParams) {
    args.push("--field", field);
  }

  if (options?.paginate) {
    args.push("--paginate");
  }

  const result = await pi.exec("glab", args, {
    signal: options?.signal,
    timeout: 90_000,
  });
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "glab api failed").trim(),
    );
  }

  const out = result.stdout.trim();
  if (options?.raw) return result.stdout;
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`Failed to parse glab api output as JSON for ${endpoint}`);
  }
}

// ---- Search path safety ----

function validateSearchPath(input: string): string {
  const normalized = normalizePath(input);
  // Reject paths with spaces, quotes, or backticks to prevent
  // unintended search scope manipulation
  if (/[\s:"'`]/.test(normalized)) {
    throw new Error("Invalid path: search path contains unsafe characters");
  }
  return normalized;
}

// ---- Diff status mapping ----

function mapGitLabDiffStatus(file: any): string {
  if (file.deleted_file) return "removed";
  if (file.new_file) return "added";
  if (file.renamed_file) return "renamed";
  return "modified";
}

// ---- Summaries ----

export function summarizeGitlabToolCall(toolName: string, args: any): string {
  const project = typeof args?.project === "string" ? args.project : undefined;

  switch (toolName) {
    case "read_gitlab": {
      const p = typeof args?.path === "string" ? args.path : "(unknown path)";
      return `Reading ${project ?? "GitLab project"}:${p}`;
    }
    case "search_gitlab": {
      const pattern =
        typeof args?.pattern === "string" ? args.pattern : "query";
      return `Searching GitLab code for "${truncateInline(pattern, 52)}"${project ? ` in ${project}` : ""}`;
    }
    case "glob_gitlab": {
      const pattern =
        typeof args?.filePattern === "string" ? args.filePattern : "pattern";
      return `Globbing GitLab ${truncateInline(pattern, 52)}${project ? ` in ${project}` : ""}`;
    }
    case "list_directory_gitlab": {
      const p = typeof args?.path === "string" ? args.path || "/" : "/";
      return `Listing GitLab directory ${p}${project ? ` in ${project}` : ""}`;
    }
    case "commit_search_gitlab": {
      const q =
        typeof args?.query === "string"
          ? ` for "${truncateInline(args.query, 48)}"`
          : "";
      return `Scanning GitLab commits${q}${project ? ` in ${project}` : ""}`;
    }
    case "diff_gitlab": {
      const base = typeof args?.base === "string" ? args.base : "base";
      const head = typeof args?.head === "string" ? args.head : "head";
      return `Comparing GitLab ${base}...${head}${project ? ` in ${project}` : ""}`;
    }
    case "list_gitlab_projects":
      return "Discovering GitLab projects";
    default:
      return `Running ${toolName}`;
  }
}

// ---- Tool registration ----

export function registerGitlabTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_gitlab",
    label: "Read GitLab File",
    description: "Read a file from a GitLab project with optional line range.",
    parameters: Type.Object({
      path: Type.String({ description: "The path to the file to read" }),
      read_range: Type.Optional(
        Type.Array(Type.Number(), {
          minItems: 2,
          maxItems: 2,
          description:
            "Optional [start_line, end_line] to read only specific lines",
        }),
      ),
      project: Type.String({
        description:
          "GitLab project URL or group/project path (subgroups supported)",
      }),
      ref: Type.Optional(
        Type.String({ description: "Optional branch/tag/commit ref" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const project = parseGitLabProject(params.project);
        const normalizedPath = normalizePath(params.path);
        const endpoint = `projects/${project.encodedPath}/repository/files/${encodeURIComponent(normalizedPath)}/raw`;
        const raw = await glabApi(pi, project.host, endpoint, {
          params: { ref: params.ref },
          signal,
          raw: true,
        });
        const numbered = formatNumberedFileContent(
          String(raw ?? ""),
          params.read_range as number[] | undefined,
        );

        return asTextResult({
          absolutePath: normalizedPath,
          content: numbered,
        });
      } catch (error) {
        return toolErrorResult("read_gitlab", error);
      }
    },
  });

  pi.registerTool({
    name: "list_directory_gitlab",
    label: "List GitLab Directory",
    description: "List files and directories for a path in a GitLab project.",
    parameters: Type.Object({
      path: Type.String({
        description: "Directory path to list (use empty string for root)",
      }),
      project: Type.String({ description: "GitLab project URL or path" }),
      ref: Type.Optional(
        Type.String({ description: "Optional branch/tag/commit ref" }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 1000,
          description: "Max entries to return",
        }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const project = parseGitLabProject(params.project);
        const normalizedPath = normalizePath(params.path || "");
        const endpoint = `projects/${project.encodedPath}/repository/tree`;
        const data = await glabApi(pi, project.host, endpoint, {
          params: {
            path: normalizedPath || undefined,
            ref: params.ref,
            per_page: params.limit ?? 100,
          },
          signal,
        });

        const entries = formatDirectoryEntries(
          data,
          "tree",
          params.limit ?? 100,
        );

        return asTextResult(entries);
      } catch (error) {
        return toolErrorResult("list_directory_gitlab", error);
      }
    },
  });

  pi.registerTool({
    name: "glob_gitlab",
    label: "Glob GitLab Files",
    description: "Find GitLab project files matching a glob pattern.",
    parameters: Type.Object({
      filePattern: Type.String({
        description: 'Glob pattern (e.g., "**/*.ts")',
      }),
      project: Type.String({ description: "GitLab project URL or path" }),
      ref: Type.Optional(
        Type.String({ description: "Optional branch/tag/commit ref" }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 1000,
          description: "Max files to return",
        }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const filePattern = params.filePattern.trim();
        validateFilePattern(filePattern);

        const project = parseGitLabProject(params.project);
        const endpoint = `projects/${project.encodedPath}/repository/tree`;
        const data = await glabApi(pi, project.host, endpoint, {
          params: {
            ref: params.ref,
            recursive: true,
            per_page: 100,
          },
          signal,
          paginate: true,
        });

        const all = (Array.isArray(data) ? data : [])
          .filter((node: any) => node.type === "blob")
          .map((node: any) => String(node.path))
          .filter((p: string) => globMatches(filePattern, p));

        const offset = params.offset ?? 0;
        const limit = params.limit ?? 100;
        return asTextResult(all.slice(offset, offset + limit));
      } catch (error) {
        return toolErrorResult("glob_gitlab", error);
      }
    },
  });

  pi.registerTool({
    name: "search_gitlab",
    label: "Search GitLab Code",
    description: "Search code in a GitLab project and return snippets.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search query" }),
      project: Type.String({ description: "GitLab project URL or path" }),
      path: Type.Optional(
        Type.String({ description: "Optional path prefix filter" }),
      ),
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 100, description: "Max results" }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        validateSearchPattern(params.pattern);
        const project = parseGitLabProject(params.project);
        const limit = params.limit ?? 30;
        const offset = params.offset ?? 0;
        if (offset % limit !== 0) {
          throw new Error(
            `offset (${offset}) must be divisible by limit (${limit})`,
          );
        }

        const pathFilter = params.path ? validateSearchPath(params.path) : "";
        const perPage = Math.min(limit, 100);
        const page = Math.floor(offset / perPage) + 1;
        const endpoint = `projects/${project.encodedPath}/search`;
        const data = await glabApi(pi, project.host, endpoint, {
          params: {
            scope: "blobs",
            search: params.pattern,
            per_page: perPage,
            page,
          },
          signal,
        });

        const results = (Array.isArray(data) ? data : [])
          .filter((item: any) => {
            const filename = String(item.filename ?? item.path ?? "");
            return !pathFilter || filename.startsWith(pathFilter);
          })
          .map((item: any) => ({
            file: String(item.filename ?? item.path ?? ""),
            chunks: [String(item.data ?? item.basename ?? "").slice(0, 2048)],
          }));

        return asTextResult({
          results,
          totalCount: results.length,
        });
      } catch (error) {
        return toolErrorResult("search_gitlab", error);
      }
    },
  });

  pi.registerTool({
    name: "commit_search_gitlab",
    label: "Search GitLab Commits",
    description: "Search commit history in a GitLab project.",
    parameters: Type.Object({
      project: Type.String({ description: "GitLab project URL or path" }),
      query: Type.Optional(
        Type.String({ description: "Text query for commit message/author" }),
      ),
      author: Type.Optional(
        Type.String({ description: "Author username or email" }),
      ),
      since: Type.Optional(
        Type.String({ description: "ISO date lower bound" }),
      ),
      until: Type.Optional(
        Type.String({ description: "ISO date upper bound" }),
      ),
      path: Type.Optional(
        Type.String({ description: "Filter to commits touching this path" }),
      ),
      ref: Type.Optional(Type.String({ description: "Branch/tag ref" })),
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 100, description: "Max commits" }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const project = parseGitLabProject(params.project);
        const limit = params.limit ?? 50;
        const offset = params.offset ?? 0;
        if (offset % limit !== 0) {
          throw new Error(
            `offset (${offset}) must be divisible by limit (${limit})`,
          );
        }

        const normalizedPath = params.path ? normalizePath(params.path) : "";
        const perPage = Math.min(limit, 100);
        const page = Math.floor(offset / perPage) + 1;
        const endpoint = `projects/${project.encodedPath}/repository/commits`;
        let commits = await glabApi(pi, project.host, endpoint, {
          params: {
            per_page: perPage,
            page,
            since: params.since,
            until: params.until,
            author: params.author,
            path: normalizedPath || undefined,
            ref_name: params.ref,
          },
          signal,
        });

        commits = Array.isArray(commits) ? commits : [];
        if (params.query) {
          const q = params.query.toLowerCase();
          commits = commits.filter((c: any) => {
            const msg = String(c?.message ?? c?.title ?? "").toLowerCase();
            const name = String(c?.author_name ?? "").toLowerCase();
            const email = String(c?.author_email ?? "").toLowerCase();
            return msg.includes(q) || name.includes(q) || email.includes(q);
          });
        }

        return asTextResult({
          commits: commits.map((c: any) => ({
            sha: String(c?.id ?? c?.short_id ?? ""),
            message: String(c?.message ?? c?.title ?? "").trim(),
            author: {
              name: String(c?.author_name ?? ""),
              email: String(c?.author_email ?? ""),
              date: String(c?.authored_date ?? c?.created_at ?? ""),
            },
          })),
          totalCount: commits.length,
        });
      } catch (error) {
        return toolErrorResult("commit_search_gitlab", error);
      }
    },
  });

  pi.registerTool({
    name: "diff_gitlab",
    label: "GitLab Diff",
    description: "Compare two refs in a GitLab project.",
    parameters: Type.Object({
      project: Type.String({ description: "GitLab project URL or path" }),
      base: Type.String({ description: "Base ref (branch/tag/sha)" }),
      head: Type.String({ description: "Head ref (branch/tag/sha)" }),
      includePatches: Type.Optional(
        Type.Boolean({
          description:
            "Include patch text (token-heavy, truncated to ~4k chars per file)",
        }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const project = parseGitLabProject(params.project);
        const endpoint = `projects/${project.encodedPath}/repository/compare`;
        const data = await glabApi(pi, project.host, endpoint, {
          params: {
            from: params.base,
            to: params.head,
          },
          signal,
        });

        const diffs = Array.isArray(data?.diffs) ? data.diffs : [];
        return asTextResult({
          files: diffs.map((f: any) => ({
            filename: f.new_path ?? f.old_path,
            status: mapGitLabDiffStatus(f),
            patch:
              params.includePatches && typeof f.diff === "string"
                ? f.diff.length > MAX_PATCH_CHARS
                  ? `${f.diff.slice(0, MAX_PATCH_CHARS)}\n... [truncated]`
                  : f.diff
                : undefined,
            previous_filename: f.renamed_file ? f.old_path : undefined,
          })),
          commits: Array.isArray(data?.commits) ? data.commits.length : 0,
          compare_timeout: Boolean(data?.compare_timeout),
          compare_same_ref: Boolean(data?.compare_same_ref),
        });
      } catch (error) {
        return toolErrorResult("diff_gitlab", error);
      }
    },
  });

  pi.registerTool({
    name: "list_gitlab_projects",
    label: "List GitLab Projects",
    description: "List GitLab projects by name, group, host, or language.",
    parameters: Type.Object({
      pattern: Type.Optional(
        Type.String({ description: "Optional project name pattern" }),
      ),
      group: Type.Optional(
        Type.String({ description: "Optional GitLab group full path" }),
      ),
      host: Type.Optional(
        Type.String({ description: "GitLab host; defaults to gitlab.com" }),
      ),
      language: Type.Optional(
        Type.String({ description: "Optional language filter" }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          description: "Max projects",
        }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const pattern =
          typeof params.pattern === "string" ? params.pattern.trim() : "";
        const group =
          typeof params.group === "string" ? params.group.trim() : "";
        const host = typeof params.host === "string" ? params.host.trim() : "";
        const language =
          typeof params.language === "string" ? params.language.trim() : "";

        if (!pattern && !group && !language) {
          throw new Error(
            "list_gitlab_projects requires at least one filter: pattern, group, or language",
          );
        }

        const limit = params.limit ?? 30;
        const offset = params.offset ?? 0;
        if (offset % limit !== 0) {
          throw new Error(
            `offset (${offset}) must be divisible by limit (${limit})`,
          );
        }

        const perPage = Math.min(limit, 100);
        const page = Math.floor(offset / perPage) + 1;
        const endpoint = group
          ? `groups/${encodeURIComponent(group)}/projects`
          : "projects";
        const data = await glabApi(pi, host || "gitlab.com", endpoint, {
          params: {
            search: pattern || undefined,
            simple: true,
            per_page: perPage,
            page,
          },
          signal,
        });

        let projects = Array.isArray(data) ? data : [];
        if (language) {
          const lang = language.toLowerCase();
          projects = projects.filter((p: any) =>
            String(p?.language ?? p?.programming_language ?? "")
              .toLowerCase()
              .includes(lang),
          );
        }

        return asTextResult({
          projects: projects.slice(0, limit).map((p: any) => ({
            name: p.path_with_namespace ?? p.name_with_namespace ?? p.name,
            description: p.description,
            webUrl: p.web_url,
            starCount: p.star_count,
            forksCount: p.forks_count,
            visibility: p.visibility,
          })),
          totalCount: projects.length,
        });
      } catch (error) {
        return toolErrorResult("list_gitlab_projects", error);
      }
    },
  });
}
