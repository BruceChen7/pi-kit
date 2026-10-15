.PHONY: help install install-all install-plugins install-skills install-third-party \
	install-clis install-opencli-adapters update-peer-deps update-skills test lint \
	package-settings restore-settings pi-web pi-web-restart pi-web-stop

PLUGIN_SCOPE ?= --library
THIRD_PARTY_MODE ?= --install-only
SKILLS_COMMAND ?= import
PORT ?= 30141

help:
	@echo "pi-kit installer targets:"
	@echo "  make install                 Install all: plugins, skills, third-party, extension CLIs, opencli adapters, peer deps"
	@echo "  make install-plugins         Install repo plugins (PLUGIN_SCOPE=--library|--project|--autoload)"
	@echo "  make install-skills          Install prompts and skills; uninstall skills removed from skills.txt"
	@echo "                              (SKILLS_COMMAND=import|update|export)"
	@echo "  make install-third-party     Install third-party plugins (THIRD_PARTY_MODE=--install-only|--enable-defaults)"
	@echo "  make install-clis            Install external CLIs required by extensions/ (codex, qmd, plannotator, gh, ...)"
	@echo "  make install-opencli-adapters Install opencli adapters under opencli/clis/"
	@echo "  make update-peer-deps        Sync pi peerDependencies to local pi --version"
	@echo "  make package-settings       Package extension settings + plugin data + ~/.config/qmd/index.yml + ~/work/*/.pi/teach learn data into a zip with manifest + restore guide (repo root)"
	@echo "  make restore-settings       Restore extension settings + plugin data + qmd config + teach data from a package-settings zip"
	@echo "                              (ZIP=<zip-or-dir> | DRY_RUN=1 preview | NO_BACKUP=1 skip .bak backups)"
	@echo ""
	@echo "  make pi-web                  Start Pi Web detached (PORT=$(PORT)) with the browser open"
	@echo "  make pi-web-restart          Stop the instance on PORT, then start it detached again"
	@echo "  make pi-web-stop             Stop the Pi Web instance on PORT"
	@echo ""
	@echo "Examples:"
	@echo "  make install"
	@echo "  make install-plugins PLUGIN_SCOPE=--project"
	@echo "  make install-third-party THIRD_PARTY_MODE=--enable-defaults"
	@echo "  make pi-web"

install: install-all

install-all: install-plugins install-skills install-third-party install-clis install-opencli-adapters update-peer-deps

install-plugins:
	./install-plugins.sh $(PLUGIN_SCOPE)

install-skills:
	./skills/migrate.sh $(SKILLS_COMMAND)

install-third-party:
	./install-third-party-plugins.sh $(THIRD_PARTY_MODE)

install-clis:
	./install-extension-clis.sh

install-opencli-adapters:
	./install-opencli-adapters.sh

update-peer-deps:
	npm run update:pi-agent

package-settings:
	node scripts/package-settings.mjs

restore-settings:
	node scripts/restore-settings.mjs

update-skills:
	./skills/migrate.sh update

pi-web:
	node scripts/pi-web-daemon.mjs start --port $(PORT)

pi-web-restart:
	node scripts/pi-web-daemon.mjs restart --port $(PORT)

pi-web-stop:
	pi-web stop --port $(PORT)

test:
	npm test

lint:
	npm run lint
