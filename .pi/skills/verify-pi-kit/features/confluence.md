# Confluence page tool

The confluence plugin exposes `confluence_page`, a tool that reads an internal Confluence page through the logged-in browser session and returns its content, headings, Jira keys, and Figma links. Users reach it by asking Pi to read a Confluence URL or page id. The plugin registers the tool and its two commands only when `ATLASSIAN_CONFLUENCE_BASE_URL` is set at load time; without it the extension registers nothing and stays silent.

## Sub-features

- `read-by-url`: read a page through its URL.
- `read-by-id`: read a page through its numeric page id.
- `read-by-display-url`: read a page through a `/display/<SPACE>/<Title>` URL, which the plugin resolves to an id through the REST search endpoint first.

## How to get to it (user POV)

- Ask Pi to read a Confluence page, pasting a page URL or page id.
- Type `/confluence-page <url|pageId>` or `/get-confluence-page <url|pageId>`; both send a prompt that asks the model to call the tool, and with no argument they do nothing.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done, and `ATLASSIAN_CONFLUENCE_BASE_URL` exported by the operator. Nothing in this repo sets it.
- Prove the tool is registered:
  `node scripts/verify-plugin.mjs tool --plugin confluence --tool confluence_page`
  Observable: `PASS`, `confluence_page` present in the active tool names.
- Prove the extension loads without errors:
  `node scripts/verify-plugin.mjs doctor --plugin confluence`

## Gotchas

- Without `ATLASSIAN_CONFLUENCE_BASE_URL` the tool mode run fails with `tool "confluence_page" is not registered`, and there is no user-visible error explaining why.
- `doctor` passes even when the tool is absent, because it only checks that the extension file loaded. `tool` mode is the proof.
- The commands are not a second read path: they only send a user message, so a no-argument run is `handled` with zero notifies and nothing to assert.
- This recipe proves registration, not a successful read. A real read needs `opencli` on `PATH` with the `confluence-sso` session plus network access, which makes it non-deterministic.
- With `noExtensions: true` the helper loads only this plugin. Do not expect other plugins' tools in `active-tools.json`.
