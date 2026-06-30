# Skills development tooling
#
# Some skills use yao-meta-skill (https://github.com/yaojingang/yao-meta-skill)
# for trigger evaluation, validation, and reporting.
# Prerequisites: Python 3.11+, uv, and yao-meta-skill cloned.
#
#   git clone https://github.com/yaojingang/yao-meta-skill.git ~/work/yao-meta-skill
#   cd ~/work/yao-meta-skill && uv venv --python 3.11 && uv pip install -r requirements-ci.txt
#
# Usage (run from repo root):
#   make -C skills eval SKILL=chao-go-perf
#   make -C skills validate SKILL=chao-go-perf
#   make -C skills interpretation SKILL=chao-go-perf
#   make -C skills eval-all        # Run eval on all skills with evals/

YAO_META_SKILL ?= $(HOME)/work/yao-meta-skill
SKILL ?= chao-go-perf

.PHONY: eval validate interpretation eval-all

eval: check-yao
	cd $(YAO_META_SKILL) && uv run scripts/trigger_eval.py \
	  --description-file $(CURDIR)/$(SKILL)/SKILL.md \
	  --cases $(CURDIR)/$(SKILL)/evals/trigger_cases.json \
	  --semantic-config $(CURDIR)/$(SKILL)/evals/semantic_config.json

validate: check-yao
	cd $(YAO_META_SKILL) && uv run scripts/yao.py validate $(CURDIR)/$(SKILL)

interpretation: check-yao
	cd $(YAO_META_SKILL) && uv run scripts/yao.py skill-interpretation $(CURDIR)/$(SKILL)

eval-all:
	@for d in */evals/; do \
	  skill=$${d%/}; skill=$${skill%/evals}; \
	  echo "=== $$skill ==="; \
	  $(MAKE) eval SKILL=$$skill || true; \
	done

check-yao:
	@test -d $(YAO_META_SKILL) || { \
	  echo "yao-meta-skill not found at $(YAO_META_SKILL)"; \
	  echo "Clone it:"; \
	  echo "  git clone https://github.com/yaojingang/yao-meta-skill.git $(YAO_META_SKILL)"; \
	  echo "  cd $(YAO_META_SKILL) && uv venv --python 3.11 && uv pip install -r requirements-ci.txt"; \
	  exit 1; \
	}
