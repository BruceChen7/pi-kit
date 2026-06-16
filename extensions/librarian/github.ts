/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: sanitizer intentionally detects control characters. */
/* biome-ignore-all lint/suspicious/noExplicitAny: GitHub API and pi JSON event payloads are intentionally dynamic at this adapter boundary. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  asTextResult,
  decodeBase64Utf8,
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

const GITHUB_SEARCH_PATH_UNSAFE_CHARS = /[\s:"'`]/;

function normalizeSearchPath(input: string): string {
  const normalized = normalizePath(input);
  if (!normalized || GITHUB_SEARCH_PATH_UNSAFE_CHARS.test(normalized)) {
    throw new Error("Invalid path: search path contains unsafe characters");
  }
  return normalized;
}

type GitHubRepo = {
  owner: string;
  repo: string;
  fullName: string;
};

// ---- Repository parsing ----

export function parseRepository(repository: string): GitHubRepo {
  let raw = repository.trim();
  if (!raw) throw new Error("Repository is required");

  if (raw.includes("://")) {
    const u = new URL(raw);
    if (u.hostname !== "github.com") {
      throw new Error(
        `Only github.com repositories are supported, got ${u.hostname}`,
      );
    }
    raw = u.pathname;
  }

  raw = raw.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/");
  if (parts.length !== 2) {
    throw new Error(
      `Invalid repository: expected owner/repo, got "${repository}"`,
    );
  }

  const [owner, repo] = parts;
  if (!owner || !repo) {
    throw new Error(
      `Invalid repository: expected owner/repo, got "${repository}"`,
    );
  }

  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function encodeGitHubPath(pathValue: string): string {
  return pathValue
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

// ---- gh CLI API ----

export async function ghApi(
  pi: ExtensionAPI,
  endpoint: string,
  options?: {
    method?: string;
    params?: Record<string, string | number | boolean | undefined>;
    headers?: string[];
    signal?: AbortSignal;
  },
): Promise<any> {
  if (/\s/.test(endpoint) || /[\x00-\x1F\x7F]/.test(endpoint)) {
    throw new Error("Invalid gh api endpoint");
  }

  const method = (options?.method ?? "GET").toUpperCase();
  const params = options?.params ?? {};
  const headers = options?.headers ?? [];

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
  const args: string[] = ["api", endpointWithQuery, "-X", method];

  for (const header of headers) {
    args.push("-H", header);
  }

  for (const field of fieldParams) {
    args.push("-f", field);
  }

  const result = await pi.exec("gh", args, {
    signal: options?.signal,
    timeout: 90_000,
  });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "gh api failed").trim());
  }

  const out = result.stdout.trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`Failed to parse gh api output as JSON for ${endpoint}`);
  }
}

// ---- Summaries ----

export function summarizeGithubToolCall(toolName: string, args: any): string {
  const repo =
    typeof args?.repository === "string" ? args.repository : undefined;

  switch (toolName) {
    case "read_github": {
      const p = typeof args?.path === "string" ? args.path : "(unknown path)";
      return `Reading ${repo ?? "repo"}:${p}`;
    }
    case "search_github": {
      const pattern =
        typeof args?.pattern === "string" ? args.pattern : "query";
      return `Searching code for "${truncateInline(pattern, 52)}"${repo ? ` in ${repo}` : ""}`;
    }
    case "glob_github": {
      const pattern =
        typeof args?.filePattern === "string" ? args.filePattern : "pattern";
      return `Globbing ${truncateInline(pattern, 52)}${repo ? ` in ${repo}` : ""}`;
    }
    case "list_directory_github": {
      const p = typeof args?.path === "string" ? args.path || "/" : "/";
      return `Listing directory ${p}${repo ? ` in ${repo}` : ""}`;
    }
    case "commit_search": {
      const q =
        typeof args?.query === "string"
          ? ` for "${truncateInline(args.query, 48)}"`
          : "";
      return `Scanning commits${q}${repo ? ` in ${repo}` : ""}`;
    }
    case "diff": {
      const base = typeof args?.base === "string" ? args.base : "base";
      const head = typeof args?.head === "string" ? args.head : "head";
      return `Comparing ${base}...${head}${repo ? ` in ${repo}` : ""}`;
    }
    case "list_github_repositories":
    case "list_repositories":
      return summarizeListRepositoriesCall(args);
    default:
      return `Running ${toolName}`;
  }
}

export function summarizeListRepositoriesCall(args: any): string {
  const filters: string[] = [];

  if (typeof args?.pattern === "string" && args.pattern.trim()) {
    filters.push(`name~"${truncateInline(args.pattern.trim(), 24)}"`);
  }

  if (typeof args?.organization === "string" && args.organization.trim()) {
    filters.push(`org:${args.organization.trim()}`);
  }

  if (typeof args?.language === "string" && args.language.trim()) {
    filters.push(`lang:${args.language.trim()}`);
  }

  const limit = Number.isFinite(args?.limit) ? Number(args.limit) : 30;
  const offset = Number.isFinite(args?.offset) ? Number(args.offset) : 0;

  const scope = filters.length > 0 ? ` (${filters.join(", ")})` : "";
  const page = offset > 0 ? ` [offset ${offset}, limit ${limit}]` : "";
  return `Discovering repositories${scope}${page}`;
}

// ---- Repo search helpers ----

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function tokenizePattern(pattern?: string): string[] {
  if (!pattern) return [];
  return pattern
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesPatternHighRecall(fullName: string, pattern?: string): boolean {
  if (!pattern?.trim()) return true;

  const normalizedFullName = fullName.toLowerCase();
  const normalizedPattern = pattern.toLowerCase().trim();

  if (normalizedFullName.includes(normalizedPattern)) return true;

  const tokens = tokenizePattern(normalizedPattern);
  return tokens.some((token) => normalizedFullName.includes(token));
}

function buildRepoNameSearchTerms(pattern?: string): string[] {
  const trimmed = pattern?.trim() ?? "";
  if (!trimmed) return ["*"];

  const tokens = dedupeStrings(
    trimmed
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );

  const terms: string[] = [`${trimmed} in:name`];
  if (tokens.length > 1) {
    terms.push(`${tokens.join(" OR ")} in:name`);
  }

  for (const token of tokens) {
    terms.push(`${token} in:name`);
  }

  return dedupeStrings(terms);
}

function buildRepoSearchQuery(
  nameTerm: string | undefined,
  organization: string | undefined,
  language: string | undefined,
): string {
  const queryParts: string[] = [];

  if (nameTerm?.trim()) queryParts.push(nameTerm.trim());
  if (organization?.trim()) queryParts.push(`org:${organization.trim()}`);
  if (language?.trim()) queryParts.push(`language:${language.trim()}`);

  return queryParts.length > 0 ? queryParts.join(" ") : "*";
}

// ---- Tool registration ----

export function registerGithubTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_github",
    label: "Read GitHub File",
    description:
      "Read a file from a GitHub repository with optional line range.",
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
      repository: Type.String({
        description:
          "Repository URL or owner/repo (e.g., https://github.com/owner/repo)",
      }),
      ref: Type.Optional(
        Type.String({ description: "Optional branch/tag/commit ref" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const repo = parseRepository(params.repository);
        const normalizedPath = normalizePath(params.path);
        const encodedPath = encodeGitHubPath(normalizedPath);
        const endpoint = `repos/${repo.fullName}/contents/${encodedPath}`;
        const data = await ghApi(pi, endpoint, {
          params: { ref: params.ref },
          signal,
        });

        if (!data || Array.isArray(data)) {
          throw new Error("Path points to a directory or missing file");
        }

        const raw =
          data.encoding === "base64"
            ? decodeBase64Utf8(data.content ?? "")
            : String(data.content ?? "");
        const numbered = formatNumberedFileContent(
          raw,
          params.read_range as number[] | undefined,
        );

        return asTextResult({
          absolutePath: normalizedPath,
          content: numbered,
        });
      } catch (error) {
        return toolErrorResult("read_github", error);
      }
    },
  });

  pi.registerTool({
    name: "list_directory_github",
    label: "List GitHub Directory",
    description:
      "List files and directories for a path in a GitHub repository.",
    parameters: Type.Object({
      path: Type.String({
        description: "Directory path to list (use empty string for root)",
      }),
      repository: Type.String({ description: "Repository URL or owner/repo" }),
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
        const repo = parseRepository(params.repository);
        const normalizedPath = normalizePath(params.path || "");
        const encodedPath = encodeGitHubPath(normalizedPath);
        const endpoint = `repos/${repo.fullName}/contents/${encodedPath}`;
        const data = await ghApi(pi, endpoint, {
          params: { ref: params.ref },
          signal,
        });

        if (!Array.isArray(data)) {
          throw new Error("Path is not a directory");
        }

        const entries = formatDirectoryEntries(
          data,
          "dir",
          params.limit ?? 100,
        );

        return asTextResult(entries);
      } catch (error) {
        return toolErrorResult("list_directory_github", error);
      }
    },
  });

  pi.registerTool({
    name: "glob_github",
    label: "Glob GitHub Files",
    description: "Find repository files matching a glob pattern.",
    parameters: Type.Object({
      filePattern: Type.String({
        description: 'Glob pattern (e.g., "**/*.ts")',
      }),
      repository: Type.String({ description: "Repository URL or owner/repo" }),
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

        const repo = parseRepository(params.repository);
        const ref = params.ref ?? "HEAD";
        const tree = await ghApi(
          pi,
          `repos/${repo.fullName}/git/trees/${encodeURIComponent(ref)}`,
          {
            params: { recursive: 1 },
            signal,
          },
        );

        if (!tree || !Array.isArray(tree.tree)) {
          throw new Error("Failed to fetch repository tree");
        }

        if (tree.truncated) {
          throw new Error(
            "Repository tree is too large. Use search_github or a narrower query.",
          );
        }

        const all = tree.tree
          .filter((node: any) => node.type === "blob")
          .map((node: any) => String(node.path))
          .filter((p: string) => globMatches(filePattern, p));

        const offset = params.offset ?? 0;
        const limit = params.limit ?? 100;
        return asTextResult(all.slice(offset, offset + limit));
      } catch (error) {
        return toolErrorResult("glob_github", error);
      }
    },
  });

  pi.registerTool({
    name: "search_github",
    label: "Search GitHub Code",
    description:
      "Search code in a repository and return grouped contextual snippets.",
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "Search query (supports GitHub operators AND/OR/NOT and qualifiers)",
      }),
      repository: Type.String({ description: "Repository URL or owner/repo" }),
      path: Type.Optional(
        Type.String({ description: "Optional path qualifier" }),
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
        const repo = parseRepository(params.repository);
        const limit = params.limit ?? 30;
        const offset = params.offset ?? 0;
        if (offset % limit !== 0) {
          throw new Error(
            `offset (${offset}) must be divisible by limit (${limit})`,
          );
        }

        const perPage = Math.min(limit, 100);
        const page = Math.floor(offset / perPage) + 1;
        let q = `${params.pattern} repo:${repo.fullName}`;
        if (params.path && params.path !== ".") {
          q += ` path:${normalizeSearchPath(params.path)}`;
        }

        const data = await ghApi(pi, "search/code", {
          params: { q, per_page: perPage, page },
          headers: ["Accept: application/vnd.github.v3.text-match+json"],
          signal,
        });

        const items = Array.isArray(data?.items) ? data.items : [];
        const grouped = new Map<string, string[]>();

        for (const item of items) {
          const file = String(item.path ?? "");
          let chunks = grouped.get(file);
          if (!chunks) {
            chunks = [];
            grouped.set(file, chunks);
          }

          const textMatches = Array.isArray(item.text_matches)
            ? item.text_matches
            : [];
          for (const match of textMatches) {
            if (match.property !== "content" || !match.fragment) continue;
            const fragment = String(match.fragment).trim();
            chunks.push(
              fragment.length > 2048
                ? `${fragment.slice(0, 2048)}... (truncated)`
                : fragment,
            );
          }
        }

        return asTextResult({
          results: Array.from(grouped.entries()).map(([file, chunks]) => ({
            file,
            chunks,
          })),
          totalCount: Number(data?.total_count ?? 0),
        });
      } catch (error) {
        return toolErrorResult("search_github", error);
      }
    },
  });

  pi.registerTool({
    name: "commit_search",
    label: "Search GitHub Commits",
    description:
      "Search commit history by query, author, date range, and path.",
    parameters: Type.Object({
      repository: Type.String({ description: "Repository URL or owner/repo" }),
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
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 100, description: "Max commits" }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset" }),
      ),
    }),

    async execute(_id, params, signal) {
      try {
        const repo = parseRepository(params.repository);
        const limit = params.limit ?? 50;
        const offset = params.offset ?? 0;
        if (offset % limit !== 0) {
          throw new Error(
            `offset (${offset}) must be divisible by limit (${limit})`,
          );
        }

        const perPage = Math.min(limit, 100);
        const page = Math.floor(offset / perPage) + 1;

        let commits: any[] = [];
        let totalCount = 0;

        if (params.path || !params.query) {
          const data = await ghApi(pi, `repos/${repo.fullName}/commits`, {
            params: {
              per_page: perPage,
              page,
              since: params.since,
              until: params.until,
              author: params.author,
              path: params.path,
            },
            signal,
          });

          commits = Array.isArray(data) ? data : [];

          if (params.query) {
            const q = params.query.toLowerCase();
            commits = commits.filter((c) => {
              const msg = String(c?.commit?.message ?? "").toLowerCase();
              const name = String(c?.commit?.author?.name ?? "").toLowerCase();
              const email = String(
                c?.commit?.author?.email ?? "",
              ).toLowerCase();
              return msg.includes(q) || name.includes(q) || email.includes(q);
            });
          }

          totalCount = commits.length;
        } else {
          const terms = [params.query, `repo:${repo.fullName}`].filter(
            Boolean,
          ) as string[];
          if (params.author) terms.push(`author:${params.author}`);
          if (params.since) terms.push(`author-date:>=${params.since}`);
          if (params.until) terms.push(`author-date:<=${params.until}`);

          const data = await ghApi(pi, "search/commits", {
            params: {
              q: terms.join(" "),
              per_page: perPage,
              page,
              sort: "author-date",
              order: "desc",
            },
            headers: ["Accept: application/vnd.github.cloak-preview+json"],
            signal,
          });

          commits = Array.isArray(data?.items) ? data.items : [];
          totalCount = Number(data?.total_count ?? commits.length);
        }

        const mapped = commits.map((c) => {
          const messageRaw = String(c?.commit?.message ?? "").trim();
          return {
            sha: String(c?.sha ?? ""),
            message:
              messageRaw.length > 1024
                ? `${messageRaw.slice(0, 1024)}... (truncated)`
                : messageRaw,
            author: {
              name: String(c?.commit?.author?.name ?? ""),
              email: String(c?.commit?.author?.email ?? ""),
              date: String(c?.commit?.author?.date ?? ""),
            },
          };
        });

        return asTextResult({ commits: mapped, totalCount });
      } catch (error) {
        return toolErrorResult("commit_search", error);
      }
    },
  });

  pi.registerTool({
    name: "diff",
    label: "GitHub Diff",
    description:
      "Compare two refs (commit/branch/tag) and optionally include file patches.",
    parameters: Type.Object({
      repository: Type.String({ description: "Repository URL or owner/repo" }),
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
        const repo = parseRepository(params.repository);
        const data = await ghApi(
          pi,
          `repos/${repo.fullName}/compare/${encodeURIComponent(params.base)}...${encodeURIComponent(params.head)}`,
          {
            signal,
          },
        );

        const files = (Array.isArray(data?.files) ? data.files : []).map(
          (f: any) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch:
              params.includePatches && typeof f.patch === "string"
                ? f.patch.length > MAX_PATCH_CHARS
                  ? `${f.patch.slice(0, MAX_PATCH_CHARS)}\n... [truncated]`
                  : f.patch
                : undefined,
            previous_filename: f.previous_filename,
            sha: f.sha,
            blob_url: f.blob_url,
          }),
        );

        const commits = Array.isArray(data?.commits) ? data.commits : [];
        const headCommit =
          commits.length > 0 ? commits[commits.length - 1] : undefined;

        return asTextResult({
          files,
          base_commit: {
            sha: data?.base_commit?.sha ?? params.base,
            message: String(data?.base_commit?.commit?.message ?? "").trim(),
          },
          head_commit: {
            sha: headCommit?.sha ?? params.head,
            message: String(headCommit?.commit?.message ?? "").trim(),
          },
          ahead_by: Number(data?.ahead_by ?? 0),
          behind_by: Number(data?.behind_by ?? 0),
          total_commits: Number(data?.total_commits ?? 0),
        });
      } catch (error) {
        return toolErrorResult("diff", error);
      }
    },
  });

  pi.registerTool({
    name: "list_github_repositories",
    label: "List GitHub Repositories",
    description:
      "List repositories, prioritizing repositories accessible to the authenticated user and supplementing with public search when needed.",
    parameters: Type.Object({
      pattern: Type.Optional(
        Type.String({ description: "Optional name pattern" }),
      ),
      organization: Type.Optional(
        Type.String({ description: "Optional org filter" }),
      ),
      language: Type.Optional(
        Type.String({ description: "Optional language filter" }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          description: "Max repositories",
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
        const organization =
          typeof params.organization === "string"
            ? params.organization.trim()
            : "";
        const language =
          typeof params.language === "string" ? params.language.trim() : "";

        if (!pattern && !organization && !language) {
          throw new Error(
            "list_github_repositories requires at least one filter: pattern, organization, or language",
          );
        }

        if (pattern.length > 128)
          throw new Error("pattern exceeds 128 characters");
        if (organization.length > 64)
          throw new Error("organization exceeds 64 characters");
        if (language.length > 64)
          throw new Error("language exceeds 64 characters");
        if (pattern && !organization && !language && pattern.length < 2) {
          throw new Error(
            "pattern must be at least 2 characters when used alone",
          );
        }

        const limit = params.limit ?? 30;
        const offset = params.offset ?? 0;
        if (offset % limit !== 0) {
          throw new Error(
            `offset (${offset}) must be divisible by limit (${limit})`,
          );
        }

        const userPerPage = Math.min(limit * 5, 100);
        const userPage = Math.floor(offset / userPerPage) + 1;

        const userReposRaw = await ghApi(pi, "user/repos", {
          params: {
            per_page: userPerPage,
            page: userPage,
            sort: "updated",
            affiliation: "owner,collaborator,organization_member",
          },
          signal,
        });

        let userRepos = Array.isArray(userReposRaw) ? userReposRaw : [];

        if (pattern) {
          userRepos = userRepos.filter((r) =>
            matchesPatternHighRecall(String(r.full_name ?? ""), pattern),
          );
        }

        if (organization) {
          const org = organization.toLowerCase();
          userRepos = userRepos.filter(
            (r) =>
              String(r.full_name ?? "")
                .split("/")[0]
                ?.toLowerCase() === org,
          );
        }

        if (language) {
          const lang = language.toLowerCase();
          userRepos = userRepos.filter(
            (r) => String(r.language ?? "").toLowerCase() === lang,
          );
        }

        userRepos.sort(
          (a, b) =>
            Number(b.stargazers_count ?? 0) - Number(a.stargazers_count ?? 0),
        );

        const merged = [...userRepos];
        const seen = new Set(merged.map((r) => String(r.full_name)));
        let totalCount = userRepos.length;

        if (merged.length < limit) {
          const repoNameTerms = buildRepoNameSearchTerms(pattern);

          for (const repoNameTerm of repoNameTerms) {
            if (merged.length >= limit) break;

            const remaining = Math.min(limit - merged.length, 100);
            if (remaining <= 0) break;

            const q = buildRepoSearchQuery(
              repoNameTerm,
              organization,
              language,
            );

            const search = await ghApi(pi, "search/repositories", {
              params: {
                q,
                per_page: remaining,
                sort: "stars",
                order: "desc",
              },
              signal,
            });

            const searchItems = Array.isArray(search?.items)
              ? search.items
              : [];
            let added = 0;

            for (const item of searchItems) {
              const fullName = String(item?.full_name ?? "");
              if (!fullName || seen.has(fullName)) continue;

              seen.add(fullName);
              merged.push(item);
              added += 1;

              if (merged.length >= limit) break;
            }

            totalCount += added;
          }
        }

        return asTextResult({
          repositories: merged.slice(0, limit).map((r: any) => ({
            name: r.full_name,
            description: r.description,
            language: r.language,
            stargazersCount: r.stargazers_count,
            forksCount: r.forks_count,
            private: r.private,
          })),
          totalCount,
        });
      } catch (error) {
        return toolErrorResult("list_github_repositories", error);
      }
    },
  });
}
