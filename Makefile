.PHONY: help install install-all install-plugins install-skills install-third-party \
	install-opencli-adapters update-peer-deps update-skills test lint

PLUGIN_SCOPE ?= --library
THIRD_PARTY_MODE ?= --install-only
SKILLS_COMMAND ?= import

help:
	@echo "pi-kit installer targets:"
	@echo "  make install                 Install all: plugins, skills, third-party, opencli adapters, peer deps"
	@echo "  make install-plugins         Install repo plugins (PLUGIN_SCOPE=--library|--project|--autoload)"
	@echo "  make install-skills          Install prompts and skills (SKILLS_COMMAND=import|update|export)"
	@echo "  make install-third-party     Install third-party plugins (THIRD_PARTY_MODE=--install-only|--enable-defaults)"
	@echo "  make install-opencli-adapters Install opencli adapters under opencli/clis/"
	@echo "  make update-peer-deps        Sync pi peerDependencies to local pi --version"
	@echo ""
	@echo "Examples:"
	@echo "  make install"
	@echo "  make install-plugins PLUGIN_SCOPE=--project"
	@echo "  make install-third-party THIRD_PARTY_MODE=--enable-defaults"

install: install-all

install-all: install-plugins install-skills install-third-party install-opencli-adapters update-peer-deps

install-plugins:
	./install-plugins.sh $(PLUGIN_SCOPE)

install-skills:
	./skills/migrate.sh $(SKILLS_COMMAND)

install-third-party:
	./install-third-party-plugins.sh $(THIRD_PARTY_MODE)

install-opencli-adapters:
	./install-opencli-adapters.sh

update-peer-deps:
	npm run update:pi-agent

update-skills:
	./skills/migrate.sh update

test:
	npm test

lint:
	npm run lint
