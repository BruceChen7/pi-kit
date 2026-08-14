.PHONY: help run start stop restart logs status test build-native install uninstall

LOG = /tmp/herdr-menubar.log
PID_PATTERN = src/menubar.mjs

help:
	@echo "herdr-menubar targets:"
	@echo "  make run          启动菜单栏(前台, Ctrl-C 退出)"
	@echo "  make start        后台启动菜单栏"
	@echo "  make stop         停止菜单栏"
	@echo "  make restart      重启菜单栏(后台)"
	@echo "  make logs         跟踪日志 (tail -f $(LOG))"
	@echo "  make status       查看运行状态"
	@echo "  make test         运行单元测试"
	@echo "  make build-native 编译原生补丁并装入 node_modules (glimpse icon 支持)"
	@echo "  make install      安装 LaunchAgent 开机自启"
	@echo "  make uninstall    卸载 LaunchAgent"

run:
	npm start

start:
	@nohup npm start > $(LOG) 2>&1 & \
	echo "started, pid: $$!, log: $(LOG)"

stop:
	@pkill -f "$(PID_PATTERN)" 2>/dev/null && echo "stopped" || echo "not running"

restart: stop
	@sleep 1
	$(MAKE) start

logs:
	tail -f $(LOG)

status:
	@if pgrep -f "$(PID_PATTERN)" > /dev/null 2>&1; then \
		echo "● running (pid $$(pgrep -f '$(PID_PATTERN)' | head -1))"; \
		echo "   log: $(LOG)"; \
	else \
		echo "○ not running"; \
	fi

test:
	npm test

build-native:
	npm run build:native

install:
	npm run install:launch-agent

uninstall:
	npm run uninstall:launch-agent
