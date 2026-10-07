// Builds the interactive preview: one self-contained HTML page that runs the
// visitor app and the admin app side by side against an in-browser backend.
//   node preview/build.mjs [output.html]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = process.argv[2] ?? path.join(here, 'dist', 'preview.html');

async function bundle(entry, format) {
  const result = await build({
    entryPoints: [path.join(here, entry)], bundle: true, write: false, minify: true,
    format, platform: 'browser', target: 'es2022', legalComments: 'none',
  });
  return result.outputFiles[0].text;
}

const noCloseScript = (js) => js.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');
const iconUri = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'public/icon.svg')).toString('base64')}`;

async function appHtml(file, frame, entry) {
  const js = await bundle(entry, 'esm');
  const body = fs.readFileSync(path.join(root, 'public', file), 'utf8').match(/<body>([\s\S]*)<\/body>/)[1]
    .replace(/<script type="module"[^>]*><\/script>/, '')
    .replaceAll('/icon.svg', iconUri);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head><body>${body}
<script>window.__DEMO__ = { frame: ${JSON.stringify(frame)} };</script>
<script type="module">${noCloseScript(js.replaceAll("/icon.svg", iconUri))}</script></body></html>`;
}

const apps = {
  visitor: await appHtml('index.html', 'visitor', 'entry-visitor.js'),
  admin: await appHtml('admin.html', 'admin', 'entry-admin.js'),
};
const backendJs = await bundle('entry-backend.js', 'iife');
const shell = fs.readFileSync(path.join(here, 'shell.html'), 'utf8')
  .replace('/*BACKEND*/', () => noCloseScript(backendJs))
  .replace('/*APPS*/', () => `const APPS = ${JSON.stringify(apps).replace(/<\//g, '<\\/')};`)
  .replaceAll('ICON_URI', iconUri);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, shell);
console.log(`Wrote ${out} (${Math.round(shell.length / 1024)} KB)`);
