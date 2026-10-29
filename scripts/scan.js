// Generates public/memes-manifest.json from the images in public/memes/.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'public/memes');
fs.mkdirSync(dir, { recursive: true });
const exts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg']);
const files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase())).sort();
const memes = files.map((f) => {
  const base = path.basename(f, path.extname(f));
  return { id: base.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: base.replace(/[-_]+/g, ' '), image: `memes/${f}` };
});
fs.writeFileSync(path.join(root, 'public/memes-manifest.json'), JSON.stringify(memes, null, 2));
console.log(`[scan] ${memes.length} meme image(s) found.`);
