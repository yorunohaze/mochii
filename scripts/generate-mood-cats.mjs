// Weather variants of Mochii's existing vector mascot. No network or image dependencies.
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/icons/cat.svg', import.meta.url), 'utf8');
const cat = source.replace(/^<svg[^>]*>\s*/, '').replace(/<\/svg>\s*$/, '');
const stroke = 'stroke="#5b4636" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"';
const cloud = (fill = '#e2edf5') => `<path d="M46 34C31 34 29 17 44 15C46 1 65 0 71 12C83 0 103 7 103 19C121 17 125 34 109 36H46Z" fill="${fill}" ${stroke}/>`;
const sun = `<g stroke="#d89834" stroke-width="3.5" stroke-linecap="round"><path d="M80 2V7M80 43V48M57 25H62M98 25H103M64 9L68 13M92 37L96 41M96 9L92 13M68 37L64 41"/><circle cx="80" cy="25" r="13" fill="#ffdb78"/></g>`;
const rain = `<g stroke="#6ea8c9" stroke-width="3.5" stroke-linecap="round"><path d="M47 43L43 50M66 45L62 52M87 44L83 51M107 43L103 50"/></g>`;
const fog = `<g stroke="#b0b9c1" stroke-width="4.5" stroke-linecap="round"><path d="M34 20H117M45 30H128M30 40H111"/></g>`;
const rainbow = `<g fill="none" stroke-width="6" stroke-linecap="round"><path d="M45 39A35 35 0 0 1 115 39" stroke="#e99ea5"/><path d="M52 39A28 28 0 0 1 108 39" stroke="#ffd16f"/><path d="M59 39A21 21 0 0 1 101 39" stroke="#96c9ad"/><path d="M66 39A14 14 0 0 1 94 39" stroke="#b2a2dd"/></g><g fill="#fffdf8" ${stroke}><ellipse cx="43" cy="40" rx="13" ry="7"/><ellipse cx="117" cy="40" rx="13" ry="7"/></g>`;

function raincoat(body) {
  return body
    .replace('<ellipse cx="81" cy="126" rx="35" ry="29" fill="#f8e2c2"/>', '<path d="M53 105Q81 91 107 105L119 147Q82 160 44 147Z" fill="#ffda74"/>')
    .replace('<ellipse cx="85" cy="130" rx="20" ry="19" fill="#fff8ec" stroke="none"/>', '<path d="M81 114V149" stroke="#cc9a44" stroke-width="2"/><g fill="#fff8ec" stroke-width="1.5"><circle cx="88" cy="131" r="2"/><circle cx="88" cy="141" r="2"/></g>')
    .replace('fill="#bde6cf"', 'fill="#ffcd50"');
}
const variants = [
  ['sunny', 'Sunny · happy', sun, cat],
  ['rainy', 'Rainy · sad', cloud() + rain, raincoat(cat)],
  ['foggy', 'Foggy · uncertain', fog, cat.replace('fill="#bde6cf"', 'fill="#d2dce3"')],
  ['cloudy', 'Cloudy · low energy', cloud('#ece8f2'), cat.replace('fill="#bde6cf"', 'fill="#cfc4f2"')],
  ['stormy', 'Stormy · overwhelmed', cloud('#b9b5cf') + `<path d="M80 34L69 46H80L74 58L96 41H85L91 34Z" fill="#ffe085" ${stroke}/>`, cat.replace('fill="#bde6cf"', 'fill="#b8acd9"')],
  ['rainbow', 'Rainbow · hopeful', rainbow, cat.replace('fill="#bde6cf"', 'fill="#ffc8a2"')],
];
const directory = new URL('../public/icons/moods/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [id, title, weather, body] of variants) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 220"><title>${title}</title><g transform="translate(0 50)">${body}</g>${weather}</svg>\n`;
  await writeFile(new URL(`${id}.svg`, directory), svg);
}
console.log(`Generated ${variants.length} weather cats.`);
