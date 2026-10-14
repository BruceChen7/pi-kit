---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

# Research

Investigate a question against **primary sources**, then capture the findings as a single Markdown file.

Default to Chinese for the deliverable unless the user explicitly asks for another language.

## Process

1. **Scope the question.** State what is being investigated and what would make the answer actionable. If the question is too broad to resolve in one pass, split it into the concrete sub-questions that actually need answers.

2. **Dispatch a background sub-agent** (or a `herdr-squad` investigation squad when the question has several non-overlapping scopes) so the main session keeps working while the reading happens.

3. **Investigate against primary sources** — official docs, source code, specs, RFCs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it. When sources disagree, say so and state which one wins and why.

4. **Write the findings** to a single Markdown file, citing the source for each claim. Separate facts from inference: anything not directly supported by a cited source is marked as the agent's reasoning, not a finding.

5. **Report the path** back to the user, with a short summary of what was found and what remains open.

## Output location

Save to `.pi/research/YYYY-MM-DD-<slug>.md` by default. If the repo already keeps research notes somewhere (a `docs/` convention, a notes folder, a knowledge base), match that convention instead and say where the file went.

## Quality bar

- Every non-obvious claim has a citation (URL, file path, version, or command output).
- Version/date sensitivity is recorded: which version of the docs, package, or API the finding applies to.
- Contradictions between sources are surfaced, not averaged away.
- Open questions are listed rather than guessed at.

## Attribution

Adapted from the `research` skill in https://github.com/mattpocock/skills (v1.3.1) under the MIT License.
