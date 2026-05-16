import { chromium, devices } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlFiles = [
  'index.html',
  'en/hiking-routes/index.html','en/teide-guide/index.html','en/road-trips/index.html',
  'es/hiking-routes/index.html','es/teide-guide/index.html','es/road-trips/index.html',
  'ru/hiking-routes/index.html','ru/teide-guide/index.html','ru/road-trips/index.html',
  'de/hiking-routes/index.html','de/teide-guide/index.html','de/road-trips/index.html'
].filter(Boolean);

const viewports = [
  { name: 'desktop-1440', viewport: { width: 1440, height: 900 } },
  { name: 'mobile-390', ...devices['iPhone 12'] },
  { name: 'mobile-360', viewport: { width: 360, height: 800 }, userAgent: devices['Pixel 5'].userAgent, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'tablet-768', viewport: { width: 768, height: 1024 }, userAgent: devices['iPad (gen 7)'].userAgent, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
];

const outDir = path.join(root, 'visual-audit');
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const report = [];

for (const file of htmlFiles) {
  const abs = path.join(root, file);
  const url = `file://${abs}`;
  for (const vp of viewports) {
    const context = await browser.newContext(vp.viewport ? vp : { viewport: vp.viewport });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.setViewportSize(vp.viewport ?? { width: 1440, height: 900 });
    await page.waitForTimeout(300);

    const issues = await page.evaluate(() => {
      const getRect = (el) => el.getBoundingClientRect();
      const all = [...document.body.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        const r = getRect(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });

      const overflows = [];
      const docWidth = document.documentElement.clientWidth;
      for (const el of all) {
        const r = getRect(el);
        if (r.right - docWidth > 1 || r.left < -1) {
          overflows.push({
            tag: el.tagName.toLowerCase(),
            className: el.className?.toString().slice(0, 80) ?? '',
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width)
          });
          if (overflows.length >= 15) break;
        }
      }

      const overlaps = [];
      const candidates = all.filter((el) => {
        const p = getComputedStyle(el).position;
        return p === 'fixed' || p === 'sticky' || p === 'absolute';
      }).slice(0, 120);

      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const a = candidates[i];
          const b = candidates[j];
          const ra = getRect(a);
          const rb = getRect(b);
          const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
          const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
          const area = x * y;
          if (area > 200) {
            overlaps.push({
              a: `${a.tagName.toLowerCase()}.${(a.className || '').toString().split(' ').slice(0,2).join('.')}`,
              b: `${b.tagName.toLowerCase()}.${(b.className || '').toString().split(' ').slice(0,2).join('.')}`,
              area: Math.round(area)
            });
            if (overlaps.length >= 15) break;
          }
        }
        if (overlaps.length >= 15) break;
      }

      return { overflows, overlaps, title: document.title };
    });

    const fileSlug = file.replace(/\//g, '__').replace('.html', '');
    const shotPath = path.join(outDir, `${fileSlug}--${vp.name}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });

    report.push({ page: file, viewport: vp.name, screenshot: path.relative(root, shotPath), ...issues });
    await context.close();
  }
}

await browser.close();
await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

const lines = ['# Visual Audit Report', '', `Generated: ${new Date().toISOString()}`, ''];
for (const item of report) {
  lines.push(`## ${item.page} @ ${item.viewport}`);
  lines.push(`- Title: ${item.title}`);
  lines.push(`- Screenshot: ${item.screenshot}`);
  lines.push(`- Overflows: ${item.overflows.length}`);
  lines.push(`- Overlaps: ${item.overlaps.length}`);
  if (item.overflows.length) lines.push(`- Overflow sample: ${item.overflows.slice(0,3).map(o=>`${o.tag}.${o.className}`).join(', ')}`);
  if (item.overlaps.length) lines.push(`- Overlap sample: ${item.overlaps.slice(0,3).map(o=>`${o.a} <> ${o.b}`).join(', ')}`);
  lines.push('');
}
await fs.writeFile(path.join(outDir, 'report.md'), lines.join('\n'));
console.log(`Done. Report at ${path.join(outDir, 'report.md')}`);
