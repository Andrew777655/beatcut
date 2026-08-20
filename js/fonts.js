// Caption typefaces, picked individually rather than in fixed pairs.
//
// Everything listed here is genuinely loadable: Google Fonts, Fontshare's free
// library, or a face already on the machine. Nothing is a stand-in for a font we
// cannot ship, so what the menu says is what you get.
//
// To add your own licensed font, drop the .woff2 in fonts/ and add an entry with
// `url` instead of `link`.

const GF = (spec) => `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
const FS = (spec) => `https://api.fontshare.com/v2/css?f[]=${spec}&display=swap`;

/** group: how the picker sorts them. weight/italic: how they're drawn. */
export const FONTS = [
  // ---------------------------------------------------------- heavy display
  { id: 'anton', name: 'Anton', group: 'Display', family: '"Anton"', weight: 400, link: GF('Anton') },
  { id: 'archivo-black', name: 'Archivo Black', group: 'Display', family: '"Archivo Black"', weight: 400, link: GF('Archivo+Black') },
  { id: 'bebas', name: 'Bebas Neue', group: 'Display', family: '"Bebas Neue"', weight: 400, link: GF('Bebas+Neue') },
  { id: 'oswald', name: 'Oswald', group: 'Display', family: '"Oswald"', weight: 700, link: GF('Oswald:wght@500;700') },
  { id: 'teko', name: 'Teko', group: 'Display', family: '"Teko"', weight: 700, link: GF('Teko:wght@600;700') },
  { id: 'fjalla', name: 'Fjalla One', group: 'Display', family: '"Fjalla One"', weight: 400, link: GF('Fjalla+One') },
  { id: 'staatliches', name: 'Staatliches', group: 'Display', family: '"Staatliches"', weight: 400, link: GF('Staatliches') },
  { id: 'bungee', name: 'Bungee', group: 'Display', family: '"Bungee"', weight: 400, link: GF('Bungee') },
  { id: 'titan', name: 'Titan One', group: 'Display', family: '"Titan One"', weight: 400, link: GF('Titan+One') },
  { id: 'alfa', name: 'Alfa Slab One', group: 'Display', family: '"Alfa Slab One"', weight: 400, link: GF('Alfa+Slab+One') },
  { id: 'passion', name: 'Passion One', group: 'Display', family: '"Passion One"', weight: 900, link: GF('Passion+One:wght@700;900') },
  { id: 'righteous', name: 'Righteous', group: 'Display', family: '"Righteous"', weight: 400, link: GF('Righteous') },
  { id: 'russo', name: 'Russo One', group: 'Display', family: '"Russo One"', weight: 400, link: GF('Russo+One') },
  { id: 'blackops', name: 'Black Ops One', group: 'Display', family: '"Black Ops One"', weight: 400, link: GF('Black+Ops+One') },
  { id: 'orbitron', name: 'Orbitron', group: 'Display', family: '"Orbitron"', weight: 900, link: GF('Orbitron:wght@700;900') },
  { id: 'bangers', name: 'Bangers', group: 'Display', family: '"Bangers"', weight: 400, link: GF('Bangers') },
  { id: 'luckiest', name: 'Luckiest Guy', group: 'Display', family: '"Luckiest Guy"', weight: 400, link: GF('Luckiest+Guy') },
  { id: 'clash', name: 'Clash Display', group: 'Display', family: '"Clash Display"', weight: 700, link: FS('clash-display@600,700') },
  { id: 'panchang', name: 'Panchang', group: 'Display', family: '"Panchang"', weight: 700, link: FS('panchang@600,700') },

  // ------------------------------------------------------------------- sans
  { id: 'inter', name: 'Inter', group: 'Sans', family: '"Inter"', weight: 900, link: GF('Inter:wght@700;900') },
  { id: 'archivo', name: 'Archivo', group: 'Sans', family: '"Archivo"', weight: 900, link: GF('Archivo:wght@700;900') },
  { id: 'montserrat', name: 'Montserrat', group: 'Sans', family: '"Montserrat"', weight: 900, link: GF('Montserrat:wght@700;900') },
  { id: 'poppins', name: 'Poppins', group: 'Sans', family: '"Poppins"', weight: 800, link: GF('Poppins:wght@600;800') },
  { id: 'roboto-cond', name: 'Roboto Condensed', group: 'Sans', family: '"Roboto Condensed"', weight: 700, link: GF('Roboto+Condensed:wght@700') },
  { id: 'barlow-cond', name: 'Barlow Condensed', group: 'Sans', family: '"Barlow Condensed"', weight: 800, link: GF('Barlow+Condensed:wght@600;800') },
  { id: 'kanit', name: 'Kanit', group: 'Sans', family: '"Kanit"', weight: 800, link: GF('Kanit:wght@600;800') },
  { id: 'space-grotesk', name: 'Space Grotesk', group: 'Sans', family: '"Space Grotesk"', weight: 700, link: GF('Space+Grotesk:wght@500;700') },
  { id: 'outfit', name: 'Outfit', group: 'Sans', family: '"Outfit"', weight: 800, link: GF('Outfit:wght@600;800') },
  { id: 'lexend', name: 'Lexend', group: 'Sans', family: '"Lexend"', weight: 800, link: GF('Lexend:wght@600;800') },
  { id: 'league-spartan', name: 'League Spartan', group: 'Sans', family: '"League Spartan"', weight: 800, link: GF('League+Spartan:wght@600;800') },
  { id: 'sora', name: 'Sora', group: 'Sans', family: '"Sora"', weight: 800, link: GF('Sora:wght@600;800') },
  { id: 'manrope', name: 'Manrope', group: 'Sans', family: '"Manrope"', weight: 800, link: GF('Manrope:wght@600;800') },
  { id: 'switzer', name: 'Switzer', group: 'Sans', family: '"Switzer"', weight: 800, link: FS('switzer@700,800') },
  { id: 'satoshi', name: 'Satoshi', group: 'Sans', family: '"Satoshi"', weight: 900, link: FS('satoshi@700,900') },
  { id: 'general-sans', name: 'General Sans', group: 'Sans', family: '"General Sans"', weight: 600, link: FS('general-sans@500,600') },
  { id: 'cabinet', name: 'Cabinet Grotesk', group: 'Sans', family: '"Cabinet Grotesk"', weight: 800, link: FS('cabinet-grotesk@700,800') },

  // ------------------------------------------------------------------ serif
  { id: 'playfair', name: 'Playfair Display', group: 'Serif', family: '"Playfair Display"', weight: 800, link: GF('Playfair+Display:wght@600;800') },
  { id: 'dm-serif', name: 'DM Serif Display', group: 'Serif', family: '"DM Serif Display"', weight: 400, link: GF('DM+Serif+Display') },
  { id: 'lora', name: 'Lora', group: 'Serif', family: '"Lora"', weight: 600, link: GF('Lora:wght@500;600') },
  { id: 'cormorant', name: 'Cormorant Garamond', group: 'Serif', family: '"Cormorant Garamond"', weight: 700, link: GF('Cormorant+Garamond:wght@600;700') },
  { id: 'baskerville', name: 'Libre Baskerville', group: 'Serif', family: '"Libre Baskerville"', weight: 700, link: GF('Libre+Baskerville:wght@400;700') },
  { id: 'stix', name: 'STIX Two Text', group: 'Serif', family: '"STIX Two Text"', weight: 500, link: GF('STIX+Two+Text:wght@500;700') },
  { id: 'melodrama', name: 'Melodrama', group: 'Serif', family: '"Melodrama"', weight: 700, link: FS('melodrama@600,700') },
  { id: 'zodiak', name: 'Zodiak', group: 'Serif', family: '"Zodiak"', weight: 700, link: FS('zodiak@600,700') },

  // --------------------------------------------------------- script / hand
  { id: 'yellowtail', name: 'Yellowtail', group: 'Script', family: '"Yellowtail"', weight: 400, link: GF('Yellowtail') },
  { id: 'great-vibes', name: 'Great Vibes', group: 'Script', family: '"Great Vibes"', weight: 400, link: GF('Great+Vibes') },
  { id: 'parisienne', name: 'Parisienne', group: 'Script', family: '"Parisienne"', weight: 400, link: GF('Parisienne') },
  { id: 'dancing', name: 'Dancing Script', group: 'Script', family: '"Dancing Script"', weight: 700, link: GF('Dancing+Script:wght@500;700') },
  { id: 'sacramento', name: 'Sacramento', group: 'Script', family: '"Sacramento"', weight: 400, link: GF('Sacramento') },
  { id: 'pacifico', name: 'Pacifico', group: 'Script', family: '"Pacifico"', weight: 400, link: GF('Pacifico') },
  { id: 'satisfy', name: 'Satisfy', group: 'Script', family: '"Satisfy"', weight: 400, link: GF('Satisfy') },
  { id: 'kaushan', name: 'Kaushan Script', group: 'Script', family: '"Kaushan Script"', weight: 400, link: GF('Kaushan+Script') },
  { id: 'allura', name: 'Allura', group: 'Script', family: '"Allura"', weight: 400, link: GF('Allura') },
  { id: 'lobster', name: 'Lobster', group: 'Script', family: '"Lobster"', weight: 400, link: GF('Lobster') },
  { id: 'caveat', name: 'Caveat', group: 'Script', family: '"Caveat"', weight: 700, link: GF('Caveat:wght@500;700') },
  { id: 'marker', name: 'Permanent Marker', group: 'Script', family: '"Permanent Marker"', weight: 400, link: GF('Permanent+Marker') },
  { id: 'shadows', name: 'Shadows Into Light', group: 'Script', family: '"Shadows Into Light"', weight: 400, link: GF('Shadows+Into+Light') },

  // ----------------------------------------------------- already installed
  { id: 'arial', name: 'Arial', group: 'On your system', family: 'Arial, Helvetica', weight: 700 },
  { id: 'impact', name: 'Impact', group: 'On your system', family: 'Impact, Haettenschweiler', weight: 400 },
  { id: 'times', name: 'Times New Roman', group: 'On your system', family: '"Times New Roman", Times', weight: 700 },
  { id: 'georgia', name: 'Georgia', group: 'On your system', family: 'Georgia, serif', weight: 700 },
  { id: 'verdana', name: 'Verdana', group: 'On your system', family: 'Verdana, Geneva', weight: 700 },
  { id: 'courier', name: 'Courier New', group: 'On your system', family: '"Courier New", monospace', weight: 700 },
];

export const fontById = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

/** <optgroup>-ed markup for a font <select>. */
export function fontOptions() {
  const groups = [];
  for (const f of FONTS) {
    let g = groups.find((x) => x.name === f.group);
    if (!g) groups.push((g = { name: f.group, items: [] }));
    g.items.push(f);
  }
  return groups
    .map((g) => `<optgroup label="${g.name}">` +
      g.items.map((f) => `<option value="${f.id}">${f.name}</option>`).join('') +
      '</optgroup>')
    .join('');
}

const injected = new Map(); // href -> promise resolving once the sheet parsed

/**
 * Load one font and wait until the canvas can actually draw with it. Only the
 * faces in use are fetched - loading all sixty up front would be absurd.
 */
export async function loadFont(font) {
  if (font.link) {
    if (!injected.has(font.link)) {
      injected.set(font.link, new Promise((res) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = font.link;
        link.addEventListener('load', res, { once: true });
        link.addEventListener('error', res, { once: true });
        setTimeout(res, 6000);
        document.head.appendChild(link);
      }));
    }
    // The @font-face rules don't exist until the sheet parses; probing before
    // that resolves against nothing and the canvas draws a fallback.
    await injected.get(font.link);
  }
  await document.fonts.load(`${font.weight} 64px ${font.family}`, 'AaGg').catch(() => {});
  await document.fonts.ready;
}

/** Canvas `font` string for a face at a given pixel size. */
export function fontString(font, px) {
  const italic = font.italic ? 'italic ' : '';
  return `${italic}${font.weight} ${Math.round(px)}px ${font.family}, system-ui, sans-serif`;
}
