#!/usr/bin/env node
// visual-qa capture script
// Opens each route at each viewport in headless Chromium, takes screenshots,
// and runs deterministic checks (console errors, failed requests, broken images,
// horizontal overflow, tap targets, tiny text, clipped text, axe accessibility).
// Optionally compares screenshots against a saved baseline.
//
// Usage:
//   node capture.mjs --url http://localhost:3000 [--routes /,/about]
//                    [--viewports mobile,tablet,desktop|WxH] [--out .visual-qa]
//                    [--wait 500] [--max-height 4000] [--no-axe] [--no-annotate]
//                    [--save-baseline] [--no-compare] [--diff-threshold 0.5]
//                    [--json] [--strict]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWPORTS = {
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
};

// ---------- args ----------
function parseArgs(argv) {
  const a = {
    url: null,
    routes: null,
    viewports: 'mobile,tablet,desktop',
    out: '.visual-qa',
    wait: 300,
    maxHeight: 4000,
    axe: true,
    annotate: true,
    saveBaseline: false,
    compare: true,
    diffThreshold: 0.5,
    json: false,
    strict: false,
    timeout: 30000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--url': a.url = next(); break;
      case '--routes': a.routes = next(); break;
      case '--viewports': a.viewports = next(); break;
      case '--out': a.out = next(); break;
      case '--wait': a.wait = Number(next()); break;
      case '--max-height': a.maxHeight = Number(next()); break;
      case '--timeout': a.timeout = Number(next()); break;
      case '--no-axe': a.axe = false; break;
      case '--no-annotate': a.annotate = false; break;
      case '--save-baseline': a.saveBaseline = true; break;
      case '--no-compare': a.compare = false; break;
      case '--diff-threshold': a.diffThreshold = Number(next()); break;
      case '--json': a.json = true; break;
      case '--strict': a.strict = true; break;
      case '-h': case '--help': a.help = true; break;
      default:
        if (!a.url && /^(https?|file):/.test(k)) a.url = k;
        else { console.error(`Unknown argument: ${k}`); process.exit(2); }
    }
  }
  return a;
}

function resolveViewports(spec) {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((name) => {
    if (VIEWPORTS[name]) return { name, ...VIEWPORTS[name] };
    const m = name.match(/^(\d+)x(\d+)$/);
    if (m) {
      const width = Number(m[1]);
      return { name, width, height: Number(m[2]), isMobile: width < 768, hasTouch: width < 1024 };
    }
    throw new Error(`Unknown viewport "${name}". Use mobile, tablet, desktop or WIDTHxHEIGHT.`);
  });
}

function routeSlug(route) {
  let p = route.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  if (/^file:/i.test(route)) p = p.split('/').filter(Boolean).slice(-2).join('/').replace(/\.html?$/i, '');
  const s = p.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return s || 'home';
}

// ---------- security helpers ----------
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:']);
const OUTPUT_MARKER = '.visual-qa-output';

// Strip credentials and secret-looking values before anything is written to disk or stdout.
// Inputs are truncated before reaching here, which bounds regex cost.
function redact(value) {
  if (value == null) return value;
  return String(value)
    .replace(/(\/\/)[^/@\s]+@/g, '$1[REDACTED]@')
    .replace(/([?&#;]([^=&#\s]*(token|key|secret|pass(word|wd)?|auth|session|sid|sig(nature)?|code|jwt|credential)[^=&#\s]*)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED_JWT]')
    .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, '[REDACTED_KEY]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]');
}

function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`Invalid --url: ${redact(raw)}`); }
  if (!ALLOWED_SCHEMES.has(u.protocol)) throw new Error(`Refusing URL scheme "${u.protocol}". Allowed: http, https, file.`);
  return u;
}

// Only ever delete directories this script created (marked with OUTPUT_MARKER).
function safeResetDir(dir) {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (resolved === root || (home && path.resolve(home) === resolved) || resolved === process.cwd()) {
    throw new Error(`Refusing to use ${resolved} as an output directory.`);
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlink ${resolved}.`);
    const entries = fs.readdirSync(resolved);
    if (entries.length > 0 && !entries.includes(OUTPUT_MARKER)) {
      throw new Error(`${resolved} exists and was not created by visual-qa. Choose another --out.`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, OUTPUT_MARKER), 'Created by visual-qa. Safe to delete.\n');
  return resolved;
}

// ---------- in-page checks (runs in the browser) ----------
function pageChecks({ isMobile }) {
  // Layout viewport width. window.innerWidth is NOT used: in mobile emulation the
  // browser zooms out to fit overflowing content, which hides the overflow.
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const MAX = 15;
  const out = { overflow: null, overflowElements: [], tapTargets: [], tinyText: [], clippedText: [], brokenImages: [] };

  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 4) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let p = cur.tagName.toLowerCase();
      const cls = [...cur.classList].slice(0, 2);
      if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const text = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const box = (r) => ({ x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const visible = (el, r) => {
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const mark = (el, kind) => el.setAttribute('data-vqa-issue', kind);

  // 1. Horizontal overflow
  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  if (docW > vw + 1) out.overflow = { documentWidth: docW, viewportWidth: vw, excess: docW - vw };

  const clippedByAncestor = (el) => {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (/(hidden|auto|scroll|clip)/.test(s.overflowX)) {
        const r = p.getBoundingClientRect();
        if (r.right <= vw + 1 && r.left >= -1) return true;
      }
      if (s.position === 'fixed') return false;
      p = p.parentElement;
    }
    return false;
  };
  const offenders = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const pokesRight = r.right > vw + 1;
    const cutLeft = r.left < -1 && r.right > 0;
    if ((pokesRight || cutLeft) && !clippedByAncestor(el)) offenders.add(el);
  }
  // keep only the outermost offender of each chain (the root cause)
  for (const el of offenders) {
    if (el.parentElement && offenders.has(el.parentElement)) continue;
    if (out.overflowElements.length >= MAX) break;
    const r = el.getBoundingClientRect();
    out.overflowElements.push({ selector: sel(el), text: text(el), box: box(r), overflowPx: Math.round(Math.max(r.right - vw, -r.left)) });
    mark(el, 'overflow');
  }

  // 2. Tap targets (touch viewports only) — WCAG 2.2 AA minimum 24x24
  if (isMobile) {
    const q = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[onclick],summary';
    for (const el of document.querySelectorAll(q)) {
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      const s = getComputedStyle(el);
      // inline links inside running text are exempt in WCAG 2.5.8
      if (s.display === 'inline' && el.parentElement && (el.parentElement.innerText || '').length > (el.innerText || '').length + 20) continue;
      if (r.width < 24 || r.height < 24) {
        if (out.tapTargets.length >= MAX) break;
        out.tapTargets.push({ selector: sel(el), text: text(el), size: `${Math.round(r.width)}x${Math.round(r.height)}`, box: box(r) });
        mark(el, 'tap-target');
      }
    }
  }

  // 3. Tiny text (< 12px)
  const seenTiny = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    if (!el || seenTiny.has(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    seenTiny.add(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) {
      if (out.tinyText.length >= MAX) break;
      out.tinyText.push({ selector: sel(el), text: text(el), fontSize: `${fs}px`, box: box(r) });
      mark(el, 'tiny-text');
    }
  }

  // 4. Clipped text (overflow hidden cutting content without an ellipsis / line-clamp)
  for (const el of document.querySelectorAll('body *')) {
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);
    if (!hasOwnText) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const clipX = /(hidden|clip)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis';
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none';
    const clipY = /(hidden|clip)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2 && !clamp;
    if (clipX || clipY) {
      if (out.clippedText.length >= MAX) break;
      out.clippedText.push({ selector: sel(el), text: text(el), direction: clipX ? 'horizontal' : 'vertical', box: box(r) });
      mark(el, 'clipped-text');
    }
  }

  // 5. Broken images
  for (const img of document.images) {
    const src = img.currentSrc || img.getAttribute('src');
    if (!src) continue;
    if (img.complete && img.naturalWidth === 0) {
      if (out.brokenImages.length >= MAX) break;
      out.brokenImages.push({ selector: sel(img), src: src.slice(0, 200), alt: img.alt || null });
      mark(img, 'broken-image');
    }
  }

  return out;
}

// ---------- helpers ----------
async function settle(page, wait) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  // scroll to the bottom to trigger lazy-loaded content, then back up
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight && y < 20000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.addStyleTag({
    content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}',
  }).catch(() => {});
  if (wait > 0) await page.waitForTimeout(wait);
}

async function screenshot(page, file, maxHeight) {
  // Real content height. documentElement.scrollHeight is inflated in mobile emulation
  // when content overflows sideways (the browser zooms out and stretches the layout).
  const height = await page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    const content = Math.max(de.getBoundingClientRect().height, body ? body.scrollHeight : 0, body ? body.getBoundingClientRect().height : 0);
    return Math.ceil(Math.min(Math.max(content, de.clientHeight), de.scrollHeight));
  });
  const width = page.viewportSize().width;
  const clipH = Math.min(height, maxHeight);
  await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width, height: clipH } });
  return { pageHeight: height, truncated: height > maxHeight };
}

async function compareImages(currentFile, baselineFile, diffFile, PNG, pixelmatch) {
  const a = PNG.sync.read(fs.readFileSync(baselineFile));
  const b = PNG.sync.read(fs.readFileSync(currentFile));
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (img) => {
    if (img.width === w && img.height === h) return img.data;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
    return out;
  };
  const diff = new PNG({ width: w, height: h });
  const changed = pixelmatch(crop(a), crop(b), diff.data, w, h, { threshold: 0.1 });
  fs.writeFileSync(diffFile, PNG.sync.write(diff));
  return {
    changedPercent: Number(((changed / (w * h)) * 100).toFixed(2)),
    heightChange: b.height - a.height,
    widthChange: b.width - a.width,
  };
}

const SEVERITY = { high: 3, medium: 2, low: 1 };

function collectIssues(r) {
  const issues = [];
  const add = (severity, type, message, detail) => issues.push({ severity, type, message, ...(detail ? { detail } : {}) });
  const brokenSrcs = new Set(r.checks.brokenImages.map((i) => i.src));
  for (const e of r.pageErrors) add('high', 'js-exception', e);
  for (const f of r.failedRequests) {
    if (f.resourceType === 'image' && brokenSrcs.has(f.url)) continue; // reported as broken-image
    add(['document', 'script', 'stylesheet'].includes(f.resourceType) ? 'high' : 'medium', 'failed-request', `${f.status} ${f.resourceType} ${f.url}`);
  }
  for (const e of r.consoleErrors) {
    if (/^Failed to load resource/.test(e) && r.failedRequests.length) continue; // reported as failed-request
    add('medium', 'console-error', e);
  }
  for (const img of r.checks.brokenImages) add('high', 'broken-image', `Image failed to load: ${img.src}`, img);
  if (r.checks.overflow) add('high', 'horizontal-overflow', `Page scrolls sideways: content is ${r.checks.overflow.documentWidth}px wide in a ${r.checks.overflow.viewportWidth}px viewport`);
  for (const el of r.checks.overflowElements) add(r.checks.overflow ? 'high' : 'medium', 'overflowing-element', `${el.selector} sticks out of the viewport by ${el.overflowPx}px`, el);
  for (const el of r.checks.clippedText) add('medium', 'clipped-text', `Text is cut off (${el.direction}) in ${el.selector}`, el);
  for (const el of r.checks.tapTargets) add('medium', 'small-tap-target', `Tap target ${el.selector} is ${el.size}px (min 24x24)`, el);
  for (const el of r.checks.tinyText) add('low', 'tiny-text', `Text in ${el.selector} is ${el.fontSize}`, el);
  for (const v of r.axe || []) {
    const sev = v.impact === 'critical' || v.impact === 'serious' ? 'high' : v.impact === 'moderate' ? 'medium' : 'low';
    add(sev, `a11y:${v.id}`, `${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`, { helpUrl: v.helpUrl, targets: v.nodes.map((n) => n.target.join(' ')) });
  }
  return issues.sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity]);
}

function summarize(report) {
  const L = [];
  const t = report.totals;
  L.push(`# visual-qa report`);
  L.push('');
  L.push(`Base URL: ${report.baseUrl}`);
  L.push(`Ran at: ${report.ranAt}`);
  L.push(`Result: **${report.status.toUpperCase()}** (${t.high} high, ${t.medium} medium, ${t.low} low)`);
  L.push(`Screenshots: ${report.outDir}`);
  L.push('');
  for (const r of report.results) {
    const c = { high: 0, medium: 0, low: 0 };
    r.issues.forEach((i) => c[i.severity]++);
    L.push(`## ${r.route} @ ${r.viewport} (${r.width}x${r.height})`);
    if (r.error) { L.push(`- LOAD FAILED: ${r.error}`); L.push(''); continue; }
    L.push(`- Screenshot: ${r.screenshot}${r.truncated ? ` (truncated at ${report.options.maxHeight}px of ${r.pageHeight}px)` : ''}`);
    if (r.annotated) L.push(`- Annotated (issues outlined in red): ${r.annotated}`);
    if (r.baseline) {
      L.push(r.baseline.changedPercent > report.options.diffThreshold
        ? `- CHANGED vs baseline: ${r.baseline.changedPercent}% of pixels differ${r.baseline.heightChange ? `, height ${r.baseline.heightChange > 0 ? '+' : ''}${r.baseline.heightChange}px` : ''} -> ${r.baseline.diff}`
        : `- Matches baseline (${r.baseline.changedPercent}% diff)`);
    }
    L.push(`- Issues: ${c.high} high, ${c.medium} medium, ${c.low} low`);
    for (const i of r.issues) L.push(`  - [${i.severity}] ${i.type}: ${i.message}`);
    L.push('');
  }
  return L.join('\n');
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(args.help ? 0 : 2);
  }

  let chromium, AxeBuilder, PNG, pixelmatch;
  try {
    ({ chromium } = await import('playwright'));
    if (args.axe) ({ default: AxeBuilder } = await import('@axe-core/playwright'));
    ({ PNG } = await import('pngjs'));
    ({ default: pixelmatch } = await import('pixelmatch'));
  } catch (e) {
    console.error(`Missing dependencies (${e.message}).\nRun once:  cd "${path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))}" && npm install && npx playwright install chromium`);
    process.exit(2);
  }

  validateUrl(args.url);
  const viewports = resolveViewports(args.viewports);
  const routes = args.routes ? args.routes.split(',').map((s) => s.trim()).filter(Boolean) : [null];
  for (const route of routes) if (route) validateUrl(new URL(route, args.url).href);
  if (!Number.isFinite(args.wait) || args.wait < 0 || args.wait > 60000) throw new Error('--wait must be between 0 and 60000 ms');
  if (!Number.isFinite(args.maxHeight) || args.maxHeight < 100 || args.maxHeight > 30000) throw new Error('--max-height must be between 100 and 30000');
  const outDir = safeResetDir(path.join(args.out, 'latest'));
  const baselineDir = path.resolve(args.out, 'baseline');
  const useBaseline = args.compare && !args.saveBaseline && fs.existsSync(baselineDir);

  // Default Chromium sandbox stays ON (never pass --no-sandbox).
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const route of routes) {
      const target = route ? new URL(route, args.url).href : args.url;
      const slug = routeSlug(route || args.url);
      fs.mkdirSync(path.join(outDir, slug), { recursive: true });

      for (const vp of viewports) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          acceptDownloads: false,
          permissions: [],
          serviceWorkers: 'block',
        });
        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        const failedRequests = [];
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(redact(m.text().slice(0, 300))); });
        page.on('pageerror', (e) => pageErrors.push(redact(String(e.message || e).slice(0, 300))));
        page.on('response', (res) => {
          if (res.status() >= 400) failedRequests.push({ status: res.status(), url: redact(res.url().slice(0, 200)), resourceType: res.request().resourceType() });
        });
        page.on('requestfailed', (req) => {
          const reason = req.failure()?.errorText || 'failed';
          if (!/ERR_ABORTED/.test(reason)) failedRequests.push({ status: reason, url: redact(req.url().slice(0, 200)), resourceType: req.resourceType() });
        });

        const r = { route: redact(route || target), url: redact(target), slug, viewport: vp.name, width: vp.width, height: vp.height };
        try {
          await page.goto(target, { waitUntil: 'load', timeout: args.timeout });
          await settle(page, args.wait);

          r.checks = await page.evaluate(pageChecks, { isMobile: vp.isMobile });
          for (const img of r.checks.brokenImages) img.src = redact(img.src);

          if (args.axe) {
            try {
              const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
              r.axe = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.slice(0, 8).map((n) => ({ target: n.target })) }));
              const serious = r.axe.filter((v) => v.impact === 'critical' || v.impact === 'serious');
              await page.evaluate((targets) => {
                for (const t of targets) {
                  try {
                    const el = document.querySelector(t);
                    if (el && el !== document.documentElement && el !== document.body && !el.hasAttribute('data-vqa-issue')) el.setAttribute('data-vqa-issue', 'a11y');
                  } catch {}
                }
              }, serious.flatMap((v) => v.nodes.filter((n) => n.target.length === 1).map((n) => n.target[0])));
            } catch (e) {
              r.axeError = e.message;
            }
          }

          const shot = path.join(outDir, slug, `${vp.name}.png`);
          Object.assign(r, await screenshot(page, shot, args.maxHeight));
          r.screenshot = path.relative(process.cwd(), shot);

          const marked = await page.evaluate(() => document.querySelectorAll('[data-vqa-issue]').length);
          if (args.annotate && marked > 0) {
            await page.addStyleTag({
              content: '[data-vqa-issue]{outline:3px solid #ff0040!important;outline-offset:-2px!important}[data-vqa-issue="tiny-text"]{outline-color:#ffaa00!important}[data-vqa-issue="tap-target"]{outline-color:#aa00ff!important}[data-vqa-issue="a11y"]{outline-color:#0066ff!important}',
            });
            const ann = path.join(outDir, slug, `${vp.name}.annotated.png`);
            await screenshot(page, ann, args.maxHeight);
            r.annotated = path.relative(process.cwd(), ann);
          }

          if (useBaseline) {
            const base = path.join(baselineDir, slug, `${vp.name}.png`);
            if (fs.existsSync(base)) {
              const diffFile = path.join(outDir, slug, `${vp.name}.diff.png`);
              r.baseline = { ...(await compareImages(shot, base, diffFile, PNG, pixelmatch)), diff: path.relative(process.cwd(), diffFile) };
            }
          }
        } catch (e) {
          r.error = redact(e.message.split('\n')[0].slice(0, 300));
        }
        r.consoleErrors = consoleErrors;
        r.pageErrors = pageErrors;
        r.failedRequests = failedRequests;
        r.issues = r.error ? [{ severity: 'high', type: 'load-failed', message: r.error }] : collectIssues(r);
        results.push(r);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (args.saveBaseline) {
    safeResetDir(baselineDir);
    for (const r of results) {
      if (!r.screenshot) continue;
      const dest = path.join(baselineDir, r.slug, `${r.viewport}.png`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.resolve(r.screenshot), dest);
    }
  }

  const totals = { high: 0, medium: 0, low: 0 };
  results.forEach((r) => r.issues.forEach((i) => totals[i.severity]++));
  const report = {
    baseUrl: redact(args.url),
    ranAt: new Date().toISOString(),
    status: totals.high > 0 ? 'fail' : totals.medium > 0 ? 'warn' : 'pass',
    totals,
    outDir: path.relative(process.cwd(), outDir) || '.',
    baselineSaved: args.saveBaseline ? path.relative(process.cwd(), baselineDir) : undefined,
    comparedToBaseline: useBaseline,
    options: { viewports: viewports.map((v) => v.name), maxHeight: args.maxHeight, diffThreshold: args.diffThreshold },
    results,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = summarize(report);
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);

  console.log(args.json ? JSON.stringify(report, null, 2) : md);
  if (args.saveBaseline) console.log(`\nBaseline saved to ${report.baselineSaved}`);
  if (args.strict && totals.high > 0) process.exit(1);
}

export { redact, validateUrl, routeSlug, safeResetDir };

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((e) => {
    console.error(redact(e.message || String(e)));
    process.exit(2);
  });
}
