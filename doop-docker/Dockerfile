# Build doop from an upstream tag (or any commit SHA). Tags make upgrades a
# one-line change: DOOP_REF=v0.16.0 docker compose up -d --build.
# The default v0.15.0 is schema-forward for the local data mounted by
# compose.yaml: migrations 0001..0041 are identical, 0042..0059 are applied at
# boot. Use a SHA instead if you need byte-for-byte reproducibility.
ARG DOOP_REF=v0.15.0

# ---- fetch upstream source ----
FROM oven/bun:1 AS source
ARG DOOP_REF
WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://codeload.github.com/kgoedecke/doop/tar.gz/${DOOP_REF}" \
    | tar -xz --strip-components=1

# ---- client bundle (Vite inlines env at build time; no keys needed here) ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=source /src/package.json /src/bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=source /src ./
RUN bun run build

# ---- production node_modules (installed by bun, read by Node) ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY --from=source /src/package.json /src/bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- single Node server: web + REST + /mcp + /ws on PORT ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    PORT=4400

# Chromium: get_frame_screenshot, frame images and PDF export.
# Fonts: fallback glyphs for screenshots (arrows, symbols, emoji).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY --from=source /src/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=source /src/server ./server
COPY --from=source /src/shared ./shared

# compose.yaml bind-mounts the existing local doop data here:
#   /app/data/pg     -> PGlite database (canvases, frames, comments, agent keys)
#   /app/data/assets -> uploaded images and derived thumbnails
# No DATABASE_URL means doop uses this embedded Postgres, so the designs you
# already made locally are the designs the container serves.
RUN mkdir -p /app/data

EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/index.ts"]
