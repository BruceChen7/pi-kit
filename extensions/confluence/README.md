# Confluence Extension

Pi-kit extension for reading pages from the internal SSO Confluence Server/Data Center instance.

## Configuration

Set the internal Confluence base URL:

```bash
export ATLASSIAN_CONFLUENCE_BASE_URL="https://confluence.example.test"
```

Authentication is provided by the logged-in Chrome session managed through OpenCLI. No PAT, Basic Auth, Cloud credentials, or configuration file is used.

The extension does not register tools or commands when the base URL is missing.

## Tool

The extension exposes one read-only tool:

```text
confluence_page
```

It accepts a page ID or a page URL and calls the internal Server/Data Center REST API through the logged-in browser session:

```text
GET /rest/api/content/{pageId}?expand=body.storage,version,space
```

Supported URL forms:

- Numeric page ID, e.g. `123456789`
- Page URL with a numeric ID, e.g. `/pages/viewpage.action?pageId=123456789`, `/pages/123456789`, `/spaces/SPACE/pages/123456789`
- Display URL with space key and title, e.g. `/display/SPACE/My+Page+Title`

Display URLs do not embed a page ID. The tool first resolves the space key and title to a page ID through the REST API:

```text
GET /rest/api/content?spaceKey=SPACE&title=My Page Title
```

then fetches the page content with the resolved ID.

The result includes Markdown content, headings, page metadata, Jira keys, and Figma links.

## Commands

- `/confluence-page <URL or ID>` — fetch an internal Confluence page
- `/get-confluence-page <ID>` — fetch an internal Confluence page by ID

## Browser session

The OpenCLI browser bridge must be available and Chrome must be logged in to the internal Confluence site:

```bash
opencli doctor
```

If the session needs to be established manually, open the internal Confluence page through OpenCLI and complete SSO in Chrome before invoking `confluence_page`.

## Tests

```bash
npm test -- extensions/confluence
RUN_CONFLUENCE_SMOKE=1 \
CONFLUENCE_SMOKE_PAGE_ID=3238343382 \
npm test -- extensions/confluence/smoke.test.ts
```

The smoke test is opt-in and read-only.
