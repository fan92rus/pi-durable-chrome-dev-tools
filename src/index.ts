// chrome-dev-tools: browser control inside a pi-durable agent, adapted from
// github.com/lallenlowe/pi-chrome-dev-tools (upstream). This is the pi-durable port:
// to the pi-durable extension format — the same path codex-search took.
// Lazy-launches the system Chrome (persistent profile at ~/.chrome-dev-tools/profile, stealth
// patched) on the first tool call; logins and cookies carry across sessions.
import { writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { stealth } from "@mr_ozio/playwright-stealth";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

// ------------------------------------------------------------------ browser lifecycle

const USER_DATA_DIR = join(homedir(), ".chrome-dev-tools", "profile");
const stealthChromium = stealth(chromium);

let context: BrowserContext | null = null;

async function ensureBrowser(): Promise<BrowserContext> {
  if (context) {
    try {
      await context.pages()[0]?.title();
      return context;
    } catch {
      context = null;
    }
  }
  context = await stealthChromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    // --use-mock-keychain breaks cookie reuse between automated and manual launches of the
    // profile; --enable-automation is a bot-detection signal.
    ignoreDefaultArgs: ["--use-mock-keychain", "--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.on("close", () => {
    context = null;
  });
  return context;
}

async function getActivePage(): Promise<Page> {
  const ctx = await ensureBrowser();
  const pages = ctx.pages();
  return pages[pages.length - 1] ?? (await ctx.newPage());
}

async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}

function wrapError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("Executable doesn't exist") || msg.includes("channel"))
      return "Chrome not found. Install Google Chrome or check that it's on your PATH.";
    if (msg.includes("Target closed") || msg.includes("Browser closed"))
      return "Browser was closed unexpectedly. It will relaunch on next tool call.";
    return msg;
  }
  return String(err);
}

type ToolResult = { content: [{ type: "text"; text: string }] };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (err: unknown): ToolResult => ok(`Error: ${wrapError(err)}`);

// ------------------------------------------------------------------ tools

const P = Type.Object;

const navigateTool = defineTool({
  name: "chrome_navigate",
  description: "Navigate the active tab to a URL. Launches Chrome on first call.",
  parameters: P({ url: Type.String({ description: "URL to navigate to" }) }),
  replay: "unsafe",
  execute: async ({ url }) => {
    try {
      const page = await getActivePage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return ok(`Navigated to: ${page.url()}\nTitle: ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const clickTool = defineTool({
  name: "chrome_click",
  description: "Click at viewport coordinates. Get coordinates from chrome_snapshot @(x,y) hints.",
  parameters: P({
    x: Type.Number({ description: "X coordinate in CSS pixels" }),
    y: Type.Number({ description: "Y coordinate in CSS pixels" }),
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
    clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  }),
  replay: "unsafe",
  execute: async ({ x, y, button, clickCount }) => {
    try {
      await (await getActivePage()).mouse.click(x, y, { button: button ?? "left", clickCount: clickCount ?? 1 });
      return ok(`Clicked at (${x}, ${y})`);
    } catch (err) {
      return fail(err);
    }
  },
});

const typeTool = defineTool({
  name: "chrome_type",
  description: "Type text into the currently focused element. Click an input first to focus it.",
  parameters: P({ text: Type.String({ description: "Text to type into the focused element" }) }),
  replay: "unsafe",
  execute: async ({ text }) => {
    try {
      await (await getActivePage()).keyboard.type(text);
      return ok(`Typed ${text.length} characters`);
    } catch (err) {
      return fail(err);
    }
  },
});

const pressKeyTool = defineTool({
  name: "chrome_press_key",
  description: "Press a keyboard key (Enter, Tab, Escape, arrows, characters).",
  parameters: P({ key: Type.String({ description: "Key to press, e.g. Enter, Tab, ArrowDown" }) }),
  replay: "unsafe",
  execute: async ({ key }) => {
    try {
      await (await getActivePage()).keyboard.press(key);
      return ok(`Pressed key: ${key}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const scrollTool = defineTool({
  name: "chrome_scroll",
  description: "Scroll the page. deltaY positive = down, negative = up. Default scrolls down 300px.",
  parameters: P({
    deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll amount" })),
    deltaY: Type.Optional(Type.Number({ description: "Vertical scroll amount. Positive = down." })),
  }),
  replay: "unsafe",
  execute: async (args) => {
    try {
      const page = await getActivePage();
      await page.mouse.wheel(args.deltaX ?? 0, args.deltaY ?? 300);
      await page.waitForTimeout(200);
      const s = await page.evaluate(() => ({
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        total: document.documentElement.scrollHeight,
        visible: document.documentElement.clientHeight,
      }));
      return ok(`Scrolled. Position: (${s.x}, ${s.y}) / ${s.total}px total, ${s.visible}px visible`);
    } catch (err) {
      return fail(err);
    }
  },
});

const executeJsTool = defineTool({
  name: "chrome_execute_js",
  description:
    "Execute JavaScript in the page and return the result. Best for surgical DOM reads — element text, attributes, values, geometry. Prefer this over chrome_screenshot for extracting data.",
  parameters: P({ expression: Type.String({ description: "JavaScript to evaluate. Last expression is returned." }) }),
  replay: "unsafe",
  execute: async ({ expression }) => {
    try {
      const result = await (await getActivePage()).evaluate(expression);
      return ok(result === undefined ? "undefined" : JSON.stringify(result, null, 2));
    } catch (err) {
      return fail(err);
    }
  },
});

const screenshotTool = defineTool({
  name: "chrome_screenshot",
  description: "Capture a PNG screenshot to disk. Visual verification only; use chrome_snapshot for page understanding.",
  parameters: P({
    fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
    path: Type.Optional(Type.String({ description: "Save path. Defaults to a temp file." })),
  }),
  replay: "safe",
  execute: async (args) => {
    try {
      const page = await getActivePage();
      const savePath = args.path ?? join(tmpdir(), `chrome-screenshot-${Date.now()}.png`);
      writeFileSync(savePath, await page.screenshot({ fullPage: args.fullPage ?? false, type: "png" }));
      return ok(`Screenshot saved to: ${savePath}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const pageInfoTool = defineTool({
  name: "chrome_page_info",
  description: "Get current page URL, title, viewport size, and scroll position.",
  parameters: P({}),
  replay: "safe",
  execute: async () => {
    try {
      const info = await (await getActivePage()).evaluate(() => ({
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        pageSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      }));
      return ok(
        `URL: ${info.url}\nTitle: ${info.title}\nViewport: ${info.viewport.width}x${info.viewport.height}\n` +
          `Scroll: (${info.scroll.x}, ${info.scroll.y})\nPage: ${info.pageSize.width}x${info.pageSize.height}`,
      );
    } catch (err) {
      return fail(err);
    }
  },
});

const waitTool = defineTool({
  name: "chrome_wait",
  description: "Wait a specified number of seconds.",
  parameters: P({ seconds: Type.Number({ minimum: 0.1, maximum: 60, description: "Seconds to wait" }) }),
  replay: "safe",
  execute: async ({ seconds }) => {
    await (await getActivePage()).waitForTimeout(seconds * 1000);
    return ok(`Waited ${seconds}s`);
  },
});

const waitForLoadTool = defineTool({
  name: "chrome_wait_for_load",
  description: "Wait until the page reaches document.readyState === 'complete'.",
  parameters: P({ timeout: Type.Optional(Type.Number({ description: "Timeout in seconds, default 15" })) }),
  replay: "safe",
  execute: async ({ timeout }) => {
    try {
      const page = await getActivePage();
      await page.waitForLoadState("load", { timeout: (timeout ?? 15) * 1000 });
      return ok(`Page loaded: ${page.url()} — ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const goBackTool = defineTool({
  name: "chrome_go_back",
  description: "Navigate back one page in history.",
  parameters: P({}),
  replay: "unsafe",
  execute: async () => {
    try {
      const page = await getActivePage();
      if (!(await page.goBack({ waitUntil: "domcontentloaded" }))) return ok("No previous page in history.");
      return ok(`Back to: ${page.url()} — ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const goForwardTool = defineTool({
  name: "chrome_go_forward",
  description: "Navigate forward one page in history.",
  parameters: P({}),
  replay: "unsafe",
  execute: async () => {
    try {
      const page = await getActivePage();
      if (!(await page.goForward({ waitUntil: "domcontentloaded" }))) return ok("No forward page in history.");
      return ok(`Forward to: ${page.url()} — ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const reloadTool = defineTool({
  name: "chrome_reload",
  description: "Reload the current page.",
  parameters: P({}),
  replay: "unsafe",
  execute: async () => {
    try {
      const page = await getActivePage();
      await page.reload({ waitUntil: "domcontentloaded" });
      return ok(`Reloaded: ${page.url()} — ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const listTabsTool = defineTool({
  name: "chrome_list_tabs",
  description: "List all open tabs with their URLs and titles.",
  parameters: P({}),
  replay: "safe",
  execute: async () => {
    try {
      const pages = (await ensureBrowser()).pages();
      const lines = await Promise.all(
        pages.map(async (p, i) => `[${i}] ${p.url()} — ${await p.title().catch(() => "(untitled)")}`),
      );
      return ok(lines.length ? lines.join("\n") : "No tabs open.");
    } catch (err) {
      return fail(err);
    }
  },
});

const switchTabTool = defineTool({
  name: "chrome_switch_tab",
  description: "Switch to a tab by index (from chrome_list_tabs).",
  parameters: P({ index: Type.Integer({ minimum: 0, description: "Tab index from chrome_list_tabs" }) }),
  replay: "unsafe",
  execute: async ({ index }) => {
    try {
      const pages = (await ensureBrowser()).pages();
      if (index >= pages.length) return ok(`Tab index ${index} out of range (${pages.length} tabs open).`);
      const page = pages[index]!;
      await page.bringToFront();
      return ok(`Switched to tab ${index}: ${page.url()} — ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const newTabTool = defineTool({
  name: "chrome_new_tab",
  description: "Open a new tab, optionally navigating to a URL.",
  parameters: P({ url: Type.Optional(Type.String({ description: "URL to open. Defaults to about:blank." })) }),
  replay: "unsafe",
  execute: async ({ url }) => {
    try {
      const ctx = await ensureBrowser();
      const page = await ctx.newPage();
      if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return ok(`New tab [${ctx.pages().indexOf(page)}]: ${page.url()} — ${await page.title()}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const closeTabTool = defineTool({
  name: "chrome_close_tab",
  description: "Close a tab by index. Defaults to the active (last) tab.",
  parameters: P({ index: Type.Optional(Type.Integer({ minimum: 0, description: "Tab index. Defaults to active tab." })) }),
  replay: "unsafe",
  execute: async ({ index }) => {
    try {
      const pages = (await ensureBrowser()).pages();
      const idx = index ?? pages.length - 1;
      if (idx >= pages.length) return ok(`Tab index ${idx} out of range (${pages.length} tabs open).`);
      const url = pages[idx]!.url();
      await pages[idx]!.close();
      return ok(`Closed tab ${idx}: ${url}`);
    } catch (err) {
      return fail(err);
    }
  },
});

const closeBrowserTool = defineTool({
  name: "chrome_close",
  description: "Close the browser entirely. It will relaunch on the next tool call.",
  parameters: P({}),
  replay: "unsafe",
  execute: async () => {
    await closeBrowser();
    return ok("Browser closed.");
  },
});

// ------------------------------------------------------------------ snapshot (accessibility tree)

type AxValue = { value?: unknown };
interface RawAxNode {
  nodeId: string;
  parentId?: string;
  childIds?: readonly string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: readonly { name?: string; value?: AxValue }[];
  backendDOMNodeId?: number;
}
interface SlimNode {
  role: string;
  name?: string;
  value?: string;
  state?: string;
  box?: { cx: number; cy: number };
  children: SlimNode[];
  _backendId?: number;
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "menuitem", "tab", "switch", "slider", "searchbox", "spinbutton",
]);

function stringOf(v: AxValue | undefined): string | undefined {
  const x = v?.value;
  if (typeof x === "string" && x !== "") return x;
  if (typeof x === "number") return String(x);
  return undefined;
}

function collectState(props: RawAxNode["properties"]): string | undefined {
  if (!props?.length) return undefined;
  const flags: string[] = [];
  for (const p of props) {
    if (!p.name) continue;
    const raw = p.value?.value;
    if (raw === true && ["focused", "required", "disabled", "checked", "expanded", "selected", "pressed", "modal"].includes(p.name))
      flags.push(p.name);
    if (typeof raw === "number" && p.name === "level") flags.push(`level ${raw}`);
  }
  return flags.length ? flags.join(", ") : undefined;
}

function buildTree(rawNodes: readonly RawAxNode[], opts: { interestingOnly: boolean; maxNodes: number }): SlimNode[] {
  const byId = new Map<string, RawAxNode>();
  for (const n of rawNodes) byId.set(n.nodeId, n);
  const rootIds = rawNodes.filter((n) => !n.parentId || !byId.has(n.parentId)).map((n) => n.nodeId);
  let budget = opts.maxNodes;

  const slim = (node: RawAxNode): SlimNode | undefined => {
    if (budget <= 0) return undefined;
    if (opts.interestingOnly && node.ignored) {
      const hoisted: SlimNode[] = [];
      for (const cid of node.childIds ?? []) {
        const s = byId.get(cid) && slim(byId.get(cid)!);
        if (s?.role === "_hoist") hoisted.push(...s.children);
        else if (s) hoisted.push(s);
      }
      return hoisted.length ? { role: "_hoist", children: hoisted } : undefined;
    }
    budget--;
    const out: SlimNode = { role: stringOf(node.role) ?? "unknown", children: [] };
    const name = stringOf(node.name);
    const value = stringOf(node.value);
    const state = collectState(node.properties);
    if (name !== undefined) out.name = name;
    if (value !== undefined) out.value = value;
    if (state !== undefined) out.state = state;
    if (node.backendDOMNodeId !== undefined) out._backendId = node.backendDOMNodeId;
    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (!child) continue;
      const s = slim(child);
      if (!s) continue;
      if (s.role === "_hoist") out.children.push(...s.children);
      else out.children.push(s);
    }
    return out;
  };

  const result: SlimNode[] = [];
  for (const rid of rootIds) {
    const root = byId.get(rid);
    if (!root) continue;
    const s = slim(root);
    if (!s) continue;
    if (s.role === "_hoist") result.push(...s.children);
    else result.push(s);
  }
  return result;
}

function renderOutline(nodes: readonly SlimNode[], depth = 0): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const indent = "  ".repeat(depth);
    let line = `${indent}- ${n.role}`;
    if (n.name) line += ` "${n.name}"`;
    if (n.value && n.value !== n.name) line += ` = ${JSON.stringify(n.value)}`;
    if (n.state) line += ` (${n.state})`;
    if (n.box && INTERACTIVE_ROLES.has(n.role)) line += ` @(${n.box.cx},${n.box.cy})`;
    lines.push(line);
    const childText = renderOutline(n.children, depth + 1);
    if (childText) lines.push(childText);
  }
  return lines.join("\n");
}

const snapshotTool = defineTool({
  name: "chrome_snapshot",
  description:
    "DEFAULT tool for understanding what's on the page: the accessibility tree with click coordinates @(x,y) for interactive elements. Use BEFORE deciding if you need a screenshot.",
  parameters: P({
    interestingOnly: Type.Optional(Type.Boolean({ description: "Filter out uninteresting AX nodes (default true)" })),
    maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Cap on nodes returned (default 1000)" })),
  }),
  replay: "safe",
  execute: async (args) => {
    let page: Page;
    try {
      page = await getActivePage();
    } catch (err) {
      return fail(err);
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      const ax = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: RawAxNode[] };
      const slim = buildTree(ax.nodes, {
        interestingOnly: args.interestingOnly ?? true,
        maxNodes: args.maxNodes ?? 1000,
      });
      // Annotate interactive nodes with click coordinates.
      const targets: { node: SlimNode; backendId: number }[] = [];
      const walk = (ns: readonly SlimNode[]) => {
        for (const n of ns) {
          if (n._backendId !== undefined && INTERACTIVE_ROLES.has(n.role)) targets.push({ node: n, backendId: n._backendId });
          walk(n.children);
        }
      };
      walk(slim);
      await Promise.allSettled(
        targets.map(async ({ node, backendId }) => {
          try {
            const r = (await cdp.send("DOM.getBoxModel", { backendNodeId: backendId })) as {
              model?: { content?: readonly number[]; width?: number; height?: number };
            };
            const c = r.model?.content;
            if (!c || c.length < 8) return;
            const x = c[0]!, y = c[1]!;
            const w = r.model!.width ?? 0, h = r.model!.height ?? 0;
            if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
            node.box = { cx: Math.round(x + w / 2), cy: Math.round(y + h / 2) };
          } catch {}
        }),
      );
      return ok(`URL: ${page.url()}\nTitle: ${await page.title()}\n\n${renderOutline(slim)}`);
    } catch (err) {
      return fail(err);
    } finally {
      await cdp.detach().catch(() => {});
    }
  },
});

// ------------------------------------------------------------------ extension

export function createChromeDevToolsExtension(): Extension {
  return defineExtension({
    name: "chrome-dev-tools",
    tools: [
      navigateTool, snapshotTool, executeJsTool, clickTool, typeTool, pressKeyTool, scrollTool,
      screenshotTool, pageInfoTool, waitTool, waitForLoadTool, goBackTool, goForwardTool, reloadTool,
      listTabsTool, switchTabTool, newTabTool, closeTabTool, closeBrowserTool,
    ],
    sections: [
      section(
        "chrome-dev-tools",
        () =>
          "chrome_* tools drive the system Chrome (persistent profile, logins kept). chrome_snapshot is the " +
          "default for page understanding: an accessibility tree with @(x,y) click coordinates to pass to " +
          "chrome_click. chrome_execute_js for surgical DOM reads. Only chrome_screenshot for visual verification.",
        { tag: false },
      ),
    ],
  });
}
