---
description: Fetch my recent X bookmarks or likes with content and links for quick reading
argument-hint: "[limit] [bookmarks|likes] [theme]"
---
Fetch my recent X saved items with **both content and direct links**, optimized for fast reading and later triage.

Use `opencli` with the X/Twitter adapter:
- Default to **bookmarks** when no type is provided
- If the user explicitly asks for liked tweets / favorites, use **likes** instead
- Default limit: **100**
- Interpret arguments as: first = optional limit, second = optional type (`bookmarks` or `likes`), remaining arguments = optional filtering or sorting instructions
- If the user says “收藏”, interpret that as **bookmarks** by default
- If the arguments are ambiguous, infer the most likely intent and state the assumption briefly

## Command selection
- Bookmarks: `opencli twitter bookmarks --limit <N> -f json`
- Likes: `opencli twitter likes --limit <N> -f json`

## Required behavior
1. Run the appropriate `opencli twitter ... -f json` command.
2. Parse the returned items.
3. Present results in a **reading-friendly Markdown format**.
4. For every item shown, include at minimum:
   - author
   - short content summary or cleaned excerpt
   - direct X link
   - created_at when available
5. Prefer the tweet's actual text content over generic metadata.
6. If the text is long, shorten it for scanning, but preserve the meaning.
7. If the user asked for organization, group items by theme; otherwise keep reverse-chronological order.
8. If there are obvious themes, add a short top summary before the list.
9. Do **not** output raw JSON unless the user explicitly asks for it.

## Output format
Use this structure unless the user requests another one:

# X 收藏速览
- 类型：bookmarks 或 likes
- 条数：N
- 时间范围：根据返回结果概括
- 主题摘要：2-6 个主题（如果明显）

Then list items like:

## 1. <optional theme or running number>
- 作者：@handle
- 时间：<created_at>
- 内容：<cleaned readable excerpt>
- 链接：<full x.com url>

## Notes
- If `opencli` fails because login/session is missing, explain that clearly and tell the user what to run next.
- If the result set is large, prioritize readability over verbosity.
- If many posts are just bare links or very short repost-style text, say that explicitly.
- If filtering instructions are provided in the remaining user arguments, apply them during organization and mention what filter you used.

User-provided arguments: $@
