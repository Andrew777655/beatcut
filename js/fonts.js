// Font pairings for captions: a heavy "main" face plus a softer "accent" face
// used on the occasional word.
//
// LICENSING: Switzer (Fontshare), Inter / Archivo / STIX Two Text / the Google
// substitutes below, and the system faces Arial and Times New Roman can all be
// loaded here legitimately. Tempting, Vanguard, Athelas, Epic Pro, Shadow Light
// and BALBOA are commercial retail fonts that cannot be redistributed, so those
// slots use free faces chosen to sit in the same visual territory. Each is
// marked `substitute` and the UI says so.
//
// If you own a licence for the real thing, drop the .woff2 into fonts/ and add
// a `local` entry: { family: 'Vanguard', url: 'fonts/vanguard.woff2', weight: 800 }.
// It will be preferred over the substitute automatically.

const GF = (spec) => `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;

export const PAIRINGS = [
  {
    id: 'tempting-switzer',
    label: 'Tempting + Switzer',
    main: { name: 'Switzer', family: '"Switzer"', weight: 800 },
    accent: { name: 'Tempting', family: '"Yellowtail"', weight: 400, substitute: 'Yellowtail' },
    links: [
      'https://api.fontshare.com/v2/css?f[]=switzer@800,700&display=swap',
      GF('Yellowtail'),
    ],
  },
  {
    id: 'athelas-vanguard',
    label: 'Athelas + Vanguard',
    main: { name: 'Vanguard', family: '"Anton"', weight: 400, substitute: 'Anton' },
    accent: { name: 'Athelas', family: '"Lora"', weight: 500, substitute: 'Lora', italic: true },
    links: [GF('Anton'), GF('Lora:ital,wght@1,500')],
  },
  {
    id: 'inter-times',
    label: 'Inter + Times New Roman',
    main: { name: 'Inter', family: '"Inter"', weight: 900 },
    accent: { name: 'Times New Roman', family: '"Times New Roman", Times', weight: 400, italic: true },
    links: [GF('Inter:wght@700;900')],
  },
  {
    id: 'arial-epic',
    label: 'Arial Bold + Epic Pro',
    main: { name: 'Arial Bold', family: 'Arial, Helvetica', weight: 700 },
    accent: { name: 'Epic Pro', family: '"Great Vibes"', weight: 400, substitute: 'Great Vibes' },
    links: [GF('Great+Vibes')],
  },
  {
    id: 'shadow-balboa',
    label: 'Shadow Light + BALBOA',
    main: { name: 'BALBOA', family: '"Oswald"', weight: 700, substitute: 'Oswald' },
    accent: { name: 'Shadow Light', family: '"Parisienne"', weight: 400, substitute: 'Parisienne' },
    links: [GF('Oswald:wght@700'), GF('Parisienne')],
  },
  {
    id: 'archivo-stix',
    label: 'Archivo + Stix',
    main: { name: 'Archivo', family: '"Archivo"', weight: 900 },
    accent: { name: 'STIX Two Text', family: '"STIX Two Text"', weight: 400, italic: true },
    links: [GF('Archivo:wght@700;900'), GF('STIX+Two+Text:ital@1')],
  },
];

export const pairingById = (id) => PAIRINGS.find((p) => p.id === id) || PAIRINGS[0];

const injected = new Map(); // href -> promise resolving when the sheet parsed

/**
 * Load a pairing's webfonts and wait until they are actually usable.
 * Canvas draws with whatever is resolved at the moment of the call, so drawing
 * before this settles silently falls back to a system face.
 */
export async function loadPairing(pairing) {
  // The @font-face rules do not exist until the stylesheet has parsed, so
  // probing before that resolves against nothing and the canvas quietly draws
  // in a fallback face.
  await Promise.all((pairing.links || []).map((href) => {
    if (injected.has(href)) return injected.get(href);
    const ready = new Promise((res) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.addEventListener('load', res, { once: true });
      link.addEventListener('error', res, { once: true });
      setTimeout(res, 6000);
      document.head.appendChild(link);
    });
    injected.set(href, ready);
    return ready;
  }));

  // Any local licensed files take precedence over the substitute.
  for (const slot of ['main', 'accent']) {
    const f = pairing[slot];
    if (!f.local) continue;
    const face = new FontFace(f.local.family, `url(${f.local.url})`, {
      weight: String(f.local.weight || f.weight || 400),
    });
    try {
      document.fonts.add(await face.load());
      f.family = `"${f.local.family}"`;
      delete f.substitute;
    } catch { /* fall back to the substitute */ }
  }

  const probes = [
    `${pairing.main.weight} 64px ${pairing.main.family}`,
    `${pairing.accent.italic ? 'italic ' : ''}${pairing.accent.weight} 64px ${pairing.accent.family}`,
  ];
  await Promise.all(
    probes.map((p) => document.fonts.load(p, 'AaGg').catch(() => {}))
  );
  await document.fonts.ready;
}

/** Canvas `font` string for one slot of a pairing. */
export function fontString(pairing, slot, px) {
  const f = pairing[slot];
  const italic = f.italic ? 'italic ' : '';
  return `${italic}${f.weight} ${Math.round(px)}px ${f.family}, system-ui, sans-serif`;
}
