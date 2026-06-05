---
description: Deploy or cancel a SPACE platform service pipeline (TEST/LIVEISH/LIVE/UAT)
argument-hint: "<action:deploy|cancel> --service <group.service> --env <TEST|LIVEISH|LIVE|UAT> [--source <branch>] [--gray] [--force]"
---
Trigger or cancel CMDB deployment pipelines on the Shopee SPACE platform via `opencli space`.

## Prerequisites
- `opencli` installed and authenticated with the `space` site adapter.
- The browser bridge (`opencli browser check`) is running.

## Service path format
Use the pattern `<group>.<subService>`, e.g.:
- `core.retrieve` → `shopee.content.shopee_video.video_core_service.core.retrieve`
- `core.retrieve_misc` → `shopee.content.shopee_video.video_core_service.core.retrieve_misc`
- `growth.xxx` → `shopee.content.shopee_video.video_core_service.growth.xxx`

Common groups: `core`, `growth`, `media`, `job`, etc.

## Deploy

### Basic deploy to TEST
```bash
opencli space deploy --service <group.service> --env TEST --source <branch>
```

### Deploy to LIVEISH or UAT
```bash
opencli space deploy --service <group.service> --env LIVEISH --source <branch>
```
> **Note**: LIVEISH and UAT will trigger a **"Deployment Information Confirmation"** dialog — the adapter handles it automatically.

### Deploy to LIVE (auto-selects latest TAG)
```bash
# Normal rollout
opencli space deploy --service <group.service> --env LIVE

# With canary (gray) release
opencli space deploy --service <group.service> --env LIVE --gray
```
> LIVE ignores `--source` — it auto-detects the latest TAG. The adapter also auto-detects when the same commit was already built and enables **DEPLOY_ONLY** mode.

### Available environments
| Env | --source required | Behavior |
|-----|-------------------|----------|
| `TEST` | ✅ Yes (branch name) | Direct deploy |
| `LIVEISH` | ✅ Yes (branch name) | Requires confirmation dialog |
| `UAT` | ✅ Yes (branch name) | Requires confirmation dialog |
| `LIVE` | ❌ No (auto TAG) | Optional `--gray`, may trigger DEPLOY_ONLY |

## Cancel

### Cancel a running pipeline (with confirmation)
```bash
opencli space cancel --service <group.service>
```
This shows pipeline info first without cancelling — confirms before acting.

### Cancel directly
```bash
opencli space cancel --service <group.service> --force
```

## Workflow example

1. Deploy to TEST for verification:
   ```bash
   opencli space deploy --service core.retrieve_misc --env TEST --source release
   ```

2. If something goes wrong, cancel:
   ```bash
   opencli space cancel --service core.retrieve_misc --force
   ```

3. After TEST passes, promote to LIVEISH/UAT, then LIVE.

## Common scenarios
- Deploy a feature branch for testing: `--env TEST --source feature/xxx`
- Deploy release branch: `--env TEST --source release`
- Deploy hotfix to LIVE via TAG: auto-detected, just `--env LIVE`
- Rollback on LIVE: the adapter auto-detects the "same commit" warning and enables DEPLOY_ONLY; no extra flags needed.

User request: $@
