import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { structuredResult } from "../shared/structured-result.js";

/**
 * Output contracts of the librarian tools.
 *
 * Each schema describes the exact payload a tool puts into `structuredContent`,
 * so codemode scripts receive data instead of the pretty-printed JSON the model
 * reads. Values come straight from the GitHub/GitLab APIs, which may omit a key
 * or answer `null` for it: those fields are nullable and optional on purpose,
 * so the schema never claims more than the adapter can deliver.
 *
 * Error results stay text-only (`isError: true`, no `structuredContent`); a
 * script sees them as a rejected call, and `Promise.allSettled()` keeps the
 * sibling calls that succeeded.
 */

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);

/** `read_github` and `read_gitlab`: one file, numbered lines. */
export const fileContentOutputSchema = Type.Object({
  absolutePath: Type.String(),
  content: Type.String(),
});

/** `list_directory_github`, `list_directory_gitlab`, `glob_github`, `glob_gitlab`: path lists. */
export const pathListOutputSchema = Type.Array(Type.String());

/** `search_github` and `search_gitlab`: snippets grouped per file. */
export const codeSearchOutputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      file: Type.String(),
      chunks: Type.Array(Type.String()),
    }),
  ),
  totalCount: Type.Number(),
});

/** `commit_search` and `commit_search_gitlab`. */
export const commitListOutputSchema = Type.Object({
  commits: Type.Array(
    Type.Object({
      sha: Type.String(),
      message: Type.String(),
      author: Type.Object({
        name: Type.String(),
        email: Type.String(),
        date: Type.String(),
      }),
    }),
  ),
  totalCount: Type.Number(),
});

/** `diff`: GitHub compare response, trimmed to the fields the tool keeps. */
export const githubDiffOutputSchema = Type.Object({
  files: Type.Array(
    Type.Object({
      filename: nullableString,
      status: nullableString,
      additions: Type.Optional(nullableNumber),
      deletions: Type.Optional(nullableNumber),
      changes: Type.Optional(nullableNumber),
      patch: Type.Optional(Type.String()),
      previous_filename: Type.Optional(nullableString),
      sha: Type.Optional(nullableString),
      blob_url: Type.Optional(nullableString),
    }),
  ),
  base_commit: Type.Object({
    sha: Type.String(),
    message: Type.String(),
  }),
  head_commit: Type.Object({
    sha: Type.String(),
    message: Type.String(),
  }),
  ahead_by: Type.Number(),
  behind_by: Type.Number(),
  total_commits: Type.Number(),
});

/** `diff_gitlab`: GitLab compare response, trimmed to the fields the tool keeps. */
export const gitlabDiffOutputSchema = Type.Object({
  files: Type.Array(
    Type.Object({
      filename: Type.Optional(nullableString),
      status: Type.String(),
      patch: Type.Optional(Type.String()),
      previous_filename: Type.Optional(nullableString),
    }),
  ),
  commits: Type.Number(),
  compare_timeout: Type.Boolean(),
  compare_same_ref: Type.Boolean(),
});

/** `list_github_repositories`. */
export const repositoryListOutputSchema = Type.Object({
  repositories: Type.Array(
    Type.Object({
      name: Type.String(),
      description: nullableString,
      language: nullableString,
      stargazersCount: nullableNumber,
      forksCount: nullableNumber,
      private: Type.Boolean(),
    }),
  ),
  totalCount: Type.Number(),
});

/** `list_gitlab_projects`. */
export const projectListOutputSchema = Type.Object({
  projects: Type.Array(
    Type.Object({
      name: Type.Optional(nullableString),
      description: Type.Optional(nullableString),
      webUrl: Type.Optional(nullableString),
      starCount: Type.Optional(nullableNumber),
      forksCount: Type.Optional(nullableNumber),
      visibility: Type.Optional(nullableString),
    }),
  ),
  totalCount: Type.Number(),
});

/**
 * `librarian_github` and `librarian_gitlab`: the subagent's answer plus the
 * tools it was allowed to use.
 *
 * The answer is copied into the payload because a declared `outputSchema` makes
 * scripts read `structuredContent` *instead of* the text: without `text` the
 * script would get the tool list and lose the answer.
 */
export const librarianSubagentOutputSchema = Type.Object({
  text: Type.String(),
  subagentTools: Type.Array(Type.String()),
});

/** The librarian's answer as one structured result, shared by both subagent tools. */
export function librarianSubagentResult(
  finalText: string,
  subagentTools: readonly string[],
): AgentToolResult<{ text: string; subagentTools: string[] }> {
  return structuredResult(finalText, {
    text: finalText,
    subagentTools: [...subagentTools],
  });
}

/**
 * Every librarian tool's name → its declared `outputSchema`.
 *
 * The tools register these objects, so a test can prove that each of the 16
 * tools declares a schema and that no schema is left unused.
 */
export const librarianToolOutputSchemas = {
  read_github: fileContentOutputSchema,
  list_directory_github: pathListOutputSchema,
  glob_github: pathListOutputSchema,
  search_github: codeSearchOutputSchema,
  commit_search: commitListOutputSchema,
  diff: githubDiffOutputSchema,
  list_github_repositories: repositoryListOutputSchema,
  read_gitlab: fileContentOutputSchema,
  list_directory_gitlab: pathListOutputSchema,
  glob_gitlab: pathListOutputSchema,
  search_gitlab: codeSearchOutputSchema,
  commit_search_gitlab: commitListOutputSchema,
  diff_gitlab: gitlabDiffOutputSchema,
  list_gitlab_projects: projectListOutputSchema,
  librarian_github: librarianSubagentOutputSchema,
  librarian_gitlab: librarianSubagentOutputSchema,
} as const;
