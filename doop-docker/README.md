# Local doop in Docker

Containerises [kgoedecke/doop](https://github.com/kgoedecke/doop) as a single
server on host **http://localhost:4300**, which is the URL `@extensions/doop/`
already expects. Nothing under `extensions/doop/` is changed.

The existing local data directory is bind-mounted, so canvases, frames,
comments, agent keys and uploaded images made with `bun run dev` are served as-is.

## Data mapping

| Host (default) | Container | Contents |
| --- | --- | --- |
| `~/work/doop/data/pg` | `/app/data/pg` | PGlite database: canvases, frames, comments, agent keys |
| `~/work/doop/data/assets` | `/app/data/assets` | uploaded images and derived thumbnails |
| host `4300` | container `4400` | web + REST + `/mcp` + `/ws`, one origin |

`DOOP_DATA_DIR` overrides the host data path. `DOOP_REF` is an upstream **tag**
by default (`v0.15.0`); a commit SHA also works when you need a fixed build.
Doop applies migrations at boot: `v0.15.0` has the same `0001..0041` migrations
as the local data and adds `0042..0059`, so the first boot upgrades the DB in
place rather than replacing it.

## Makefile targets

From the repo root (`cd ~/work/pi-kit`):

| Target | Does |
| --- | --- |
| `make doop-start` | `docker compose up -d` — builds the image on first run |
| `make doop-stop` | `docker compose down` — host data is untouched |
| `make doop-update DOOP_REF=v0.16.0` | `docker compose up -d --build` with that tag/SHA |

Inside `doop-docker/` the same targets are plain `make start`, `make stop`,
`make update`.

The Makefile defaults to `DOCKER_CONTEXT=kiri`, because this machine's global
Docker context is `orbstack` while Kiri is the daemon actually running. That
keeps `make doop-*` working without changing your global context. Override with
`make doop-start DOCKER_CONTEXT=orbstack`, or switch globally once with
`docker context use kiri`.

## Run

```bash
# 1. Stop the local doop dev server if it is running. PGlite is a single-writer
#    embedded database; do not let `bun run dev` and the container share it.
#    (pgrep -fl 'tsx.*server/index.ts|vite' to check)

# 2. Back up once, because the first boot can apply migrations in place.
cp -a ~/work/doop/data ~/work/doop/data.bak.$(date +%s)

# 3. Start (first run builds the image automatically).
cd ~/work/pi-kit
make doop-start

# 4. Verify.
curl -fsS http://localhost:4300/healthz   # {"ok":true}
```

Open http://localhost:4300 — the old canvases and designs are there. In pi,
the existing `~/.pi/agent/doop.json` (`baseUrl: http://localhost:4300`,
`agentKey: dpk_…`) keeps working because agent keys live in the mounted DB.

To upgrade later, change one value and rebuild. The DB stays where it is and
new migrations run on the next boot:

```bash
cd ~/work/pi-kit

# Pin a known-good tag (recommended).
make doop-update DOOP_REF=v0.16.0

# Or find the newest upstream tag first.
git ls-remote --tags --refs https://github.com/kgoedecke/doop.git 'v*' \
  | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -1

# SHA override, if you need exactly the code your local clone ran.
make doop-update DOOP_REF=$(git -C ~/work/doop rev-parse HEAD)
```

`DOOP_REF` is a build arg baked into `doop-local:latest`. Changing it needs
`make doop-update`, not just `make doop-start`.

Stop with `make doop-stop`; the bind-mounted data stays on the host.

## Auth and local-only defaults

`compose.yaml` deliberately reuses doop's own development auth secret and
secrets-encryption key. That is why an existing browser session and connected
model accounts keep working without re-setup. It is fine for a **localhost-only**
deployment; it is not fine for a public one. If you expose the service, bind it
to a private interface, set fresh `BETTER_AUTH_SECRET` and
`SECRETS_ENCRYPTION_KEYS`, then re-login in the browser and reconnect encrypted
model accounts.

`BETTER_AUTH_URL=http://localhost:4300` matches the published port. Doop's
sign-in check rejects an `Origin` it does not trust, so do not change that URL
without also changing the port mapping and `@extensions/doop/` configuration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `failed to connect ... orbstack/run/docker.sock` | global context points at stopped OrbStack; use `make doop-start` (Kiri default) or `docker context use kiri` |
| `/doop status` says doop is unreachable | `docker --context kiri compose ps`, then `curl http://localhost:4300/healthz` |
| Sign-in rejected / 403 untrusted origin | `BETTER_AUTH_URL` must be the same origin the browser and pi use (`http://localhost:4300`) |
| Canvases open but images are blank | `~/work/doop/data/assets` is mounted at `/app/data/assets` |
| Chinese / Japanese / Korean text renders as boxes (□) | the image lacks a CJK font: `docker --context kiri exec doop-local-doop-1 fc-list : family \| grep -c CJK` should be > 0. `fonts-noto-cjk` is in the Dockerfile — if the running image predates that, `make doop-update` rebuilds it |
| New canvases missing after restart | `docker compose down` does not remove the bind-mounted host data |
| Port 4300 already in use | stop the old dev server / other process, or change the host side of `4300:4400` together with `BETTER_AUTH_URL` |
