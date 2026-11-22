# Changelog

## 1.0.0 (2026-11-22)

pi-durable port. Same 19 tools, rewritten as one `createChromeDevToolsExtension()` pi-durable extension (`defineExtension`/`defineTool`); replay-safe reads (snapshot, page_info, wait, screenshot, list_tabs), unsafe actions. Dropped the pi TUI renderResult. Source of the vendored `chrome-dev-tools` addon in durable-pi dpi-backend.

## 0.1.0 (2026-05-06)

Initial release.

- 19 browser tools: navigate, snapshot, click, type, press_key, execute_js, screenshot, scroll, list_tabs, switch_tab, new_tab, close_tab, page_info, wait, wait_for_load, go_back, go_forward, reload, close
- Lazy Chrome launch on first tool call — no startup delay
- Persistent user profile at `~/.chrome-dev-tools/profile`
- System Chrome via Playwright `channel: "chrome"`
- Bot detection avoidance via `@mr_ozio/playwright-stealth`
- Accessibility tree snapshot with CDP-based `@(x,y)` click coordinates
- Collapsed `renderResult` for snapshot tool (expand with Ctrl+O)
- Auto-cleanup on session shutdown
