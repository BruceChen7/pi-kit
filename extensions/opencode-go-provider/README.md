# pi-opencode-go-provider

A [pi](https://github.com/badlogic/pi-mono) extension that registers [opencode-go](https://opencode.ai/) as a custom provider. Access fast, efficient GLM, Kimi, and MiniMax models optimized for speed through a unified API.

> This is a local port of [monotykamary/pi-opencode-go-provider](https://github.com/monotykamary/pi-opencode-go-provider).

## Features

- **13 Optimized AI Models** - GLM-5, Kimi K2.5, and MiniMax M2.5
- **Fast & Efficient** - Go-optimized endpoints for lower latency
- **Unified API** via opencode.ai's OpenAI-compatible completions endpoint
- **Cost Tracking** with per-model pricing for budget management
- **Reasoning Models** support for advanced reasoning capabilities
- **Vision Support** for image-capable models

## Available Models

| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
| DeepSeek V4 Flash | Text | 1.0M | 384K | $0.14 | $0.28 |
| DeepSeek V4 Pro | Text | 1.0M | 384K | $1.74 | $3.48 |
| GLM-5.1 | Text | 203K | 33K | $1.40 | $4.40 |
| GLM-5.2 | Text | 1.0M | 131K | $1.40 | $4.40 |
| Kimi K2.6 | Text + Image | 262K | 66K | $0.95 | $4.00 |
| Kimi K2.7 Code | Text + Image | 262K | 262K | $0.95 | $4.00 |
| MiMo V2.5 | Text + Image | 1.0M | 128K | $0.14 | $0.28 |
| MiMo V2.5 Pro | Text | 1.0M | 128K | $1.74 | $3.48 |
| MiniMax-M2.7 | Text | 205K | 131K | $0.30 | $1.20 |
| MiniMax-M3 (3x usage) | Text + Image | 1.0M | 131K | $0.30 | $1.20 |
| Qwen3.6 Plus | Text + Image | 1.0M | 66K | $0.50 | $3.00 |
| Qwen3.7 Max | Text | 1.0M | 66K | $2.50 | $7.50 |
| Qwen3.7 Plus | Text + Image | 1.0M | 66K | $0.40 | $1.60 |
*Costs are per million tokens. Prices subject to change - check [opencode.ai](https://opencode.ai) for current pricing.*

## Setup

1. Set your opencode.ai API key:

   ```
   export OPENCODE_API_KEY=your-api-key-here
   ```

   Or add to `~/.pi/agent/auth.json`:
   ```json
   { "opencode-go": { "type": "api_key", "key": "your-api-key" } }
   ```

2. The extension is automatically loaded when pi-kit is installed.

3. Use `/model` in pi to select "opencode-go" as the provider.

## Updating Models

```bash
cd extensions/opencode-go-provider
npm run update-models
```

## License

MIT - See [LICENSE](LICENSE). Upstream: [monotykamary/pi-opencode-go-provider](https://github.com/monotykamary/pi-opencode-go-provider).
