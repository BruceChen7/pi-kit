# Format & Lint: Python

## Detection

Based on `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt` in the project root.

| Tool | Config file | Install check |
|---|---|---|
| **ruff** (formatter + linter, recommended) | `pyproject.toml` (`[tool.ruff]`) or `ruff.toml` | `which ruff` or `uv tool list` |
| **black** (formatter) | `pyproject.toml` (`[tool.black]`) | `which black` |
| **flake8** (linter) | `.flake8` / `setup.cfg` (`[flake8]`) | `which flake8` |
| **mypy** (type checker, optional) | `pyproject.toml` (`[tool.mypy]`) | `which mypy` |
| **pylint** (linter, optional) | `.pylintrc` / `pyproject.toml` | `which pylint` |

**Prefer ruff** when available — it covers formatting + linting in a single tool with
fast performance.

## Execution

### Format (auto-fix mode)

- **ruff**: `ruff format .`
- **black**: `black .`

### Lint (check-only mode)

- **ruff**: `ruff check .`
- **flake8**: `flake8 .`
- **mypy**: `mypy .`
- **pylint**: `pylint $(git ls-files '*.py')`

## ⚠️ Known caveats

- `ruff check --fix` exists but should only be used during **format** step, not lint — keep
  lint as read-only per the quality gate contract.
- If the project uses multiple Python versions, run tools under the correct interpreter
  (e.g., `uv run ruff check .`, `poetry run ruff check .`).
