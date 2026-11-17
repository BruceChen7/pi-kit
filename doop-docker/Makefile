# Use the Kiri daemon by default. The global docker context on this machine is
# "orbstack", whose socket is absent when OrbStack is not running. Override with
# DOCKER_CONTEXT=<name> if you switch runtimes.
DOCKER_CONTEXT ?= kiri
COMPOSE ?= docker --context $(DOCKER_CONTEXT) compose
DOOP_REF ?= v0.15.0

.PHONY: start stop update

# First run builds the image if it is missing; later starts reuse it.
start:
	$(COMPOSE) up -d

# Removes the container/network only. data/pg and data/assets live on the host.
stop:
	$(COMPOSE) down

# DOOP_REF is a build arg, so switching tag/SHA requires --build.
update:
	DOOP_REF=$(DOOP_REF) $(COMPOSE) up -d --build
