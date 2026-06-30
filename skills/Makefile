# Skills development tooling
#
# Some skills use yao-meta-skill (https://github.com/yaojingang/yao-meta-skill)
# for trigger evaluation, validation, and reporting.
# Prerequisites: Python 3.11+ and uv. This Makefile installs yao-meta-skill on demand.
#
# Usage (run from repo root):
#   make -C skills install-yao
#   make -C skills eval SKILL=chao-go-perf
#   make -C skills validate SKILL=chao-go-perf
#   make -C skills interpretation SKILL=chao-go-perf
#   make -C skills eval-all        # Run eval on all skills with evals/

YAO_META_SKILL ?= $(HOME)/work/yao-meta-skill
YAO_META_SKILL_REPO ?= https://github.com/yaojingang/yao-meta-skill.git
YAO_PYTHON ?= 3.11
SKILL ?= chao-go-perf

.PHONY: eval validate interpretation eval-all install-yao check-yao

eval: check-yao
	cd "$(YAO_META_SKILL)" && uv run python scripts/trigger_eval.py \
	  --description-file "$(CURDIR)/$(SKILL)/SKILL.md" \
	  --cases "$(CURDIR)/$(SKILL)/evals/trigger_cases.json" \
	  --semantic-config "$(CURDIR)/$(SKILL)/evals/semantic_config.json"

validate: check-yao
	cd "$(YAO_META_SKILL)" && uv run python scripts/yao.py validate "$(CURDIR)/$(SKILL)"

interpretation: check-yao
	cd "$(YAO_META_SKILL)" && uv run python scripts/yao.py skill-interpretation "$(CURDIR)/$(SKILL)"

eval-all:
	@for d in */evals/; do \
	  skill=$${d%/}; skill=$${skill%/evals}; \
	  echo "=== $$skill ==="; \
	  $(MAKE) eval SKILL=$$skill || true; \
	done

install-yao:
	@if [ ! -d "$(YAO_META_SKILL)/.git" ]; then \
	  echo "Installing yao-meta-skill into $(YAO_META_SKILL)"; \
	  mkdir -p "$$(dirname "$(YAO_META_SKILL)")"; \
	  git clone "$(YAO_META_SKILL_REPO)" "$(YAO_META_SKILL)"; \
	fi
	@cd "$(YAO_META_SKILL)" && { \
	  if [ ! -d .venv ]; then \
	    uv venv --python "$(YAO_PYTHON)"; \
	  fi; \
	  uv pip install -r requirements-ci.txt; \
	}
	@cd "$(YAO_META_SKILL)" && uv run python scripts/yao.py --help >/dev/null

check-yao: install-yao
	@test -f "$(YAO_META_SKILL)/SKILL.md" || { \
	  echo "yao-meta-skill install is incomplete at $(YAO_META_SKILL)"; \
	  exit 1; \
	}
