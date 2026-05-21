.PHONY: help install install-all install-plugins install-skills install-third-party \
	update-peer-deps update-skills test lint

PLUGIN_SCOPE ?= --library
THIRD_PARTY_MODE ?= --install-only
SKILLS_COMMAND ?= import

help:
	@echo "pi-kit installer targets:"
	@echo "  make install              Install plugins, skills, third-party plugins, update peer deps"
	@echo "  make install-plugins      Install repo plugins (PLUGIN_SCOPE=--library|--project|--autoload)"
	@echo "  make install-skills       Install prompts and skills (SKILLS_COMMAND=import|update|export)"
	@echo "  make install-third-party  Install third-party plugins (THIRD_PARTY_MODE=--install-only|--enable-defaults)"
	@echo "  make update-peer-deps     Sync pi peerDependencies to local pi --version"
	@echo ""
	@echo "Examples:"
	@echo "  make install"
	@echo "  make install-plugins PLUGIN_SCOPE=--project"
	@echo "  make install-third-party THIRD_PARTY_MODE=--enable-defaults"

install: install-all

install-all: install-plugins install-skills install-third-party update-peer-deps

install-plugins:
	./install-plugins.sh $(PLUGIN_SCOPE)

install-skills:
	./skills/migrate.sh $(SKILLS_COMMAND)

install-third-party:
	./install-third-party-plugins.sh $(THIRD_PARTY_MODE)

update-peer-deps:
	npm run update:pi-agent

update-skills:
	./skills/migrate.sh update

test:
	npm test

lint:
	npm run lint
