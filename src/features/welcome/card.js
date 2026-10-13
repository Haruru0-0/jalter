import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const FONTS = [
  ['NotoSans-Regular.woff', 'Noto Sans'],
  ['NotoSansArabic-Regular.woff', 'Noto Sans Arabic'],
];
let fontsReady = false;

function ensureFonts() {
  if (fontsReady) return;
  for (const [file, family] of FONTS) {
    const path = fileURLToPath(new URL(`../../../assets/fonts/${file}`, import.meta.url));
    if (!existsSync(path)) throw new Error(`Missing font file: ${path}`);
    const key = GlobalFonts.registerFromPath(path, family);
    if (!key || !GlobalFonts.families.some((f) => f.family === family)) {
      throw new Error(`Could not load font ${family} from ${path}`);
    }
  }
  fontsReady = true;
}

export async function renderCard({ username, avatarUrl, serverName, background }) {
  ensureFonts();
  const canvas = createCanvas(1024, 400);
  const ctx = canvas.getContext('2d');

  if (background) {
    ctx.drawImage(await loadImage(background), 0, 0, 1024, 400);
  } else {
    ctx.fillStyle = '#23272a';
    ctx.fillRect(0, 0, 1024, 400);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, 1024, 400);

  ctx.save();
  ctx.beginPath();
  ctx.arc(512, 130, 80, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatarUrl) ctx.drawImage(await loadImage(avatarUrl), 432, 50, 160, 160);
  else { ctx.fillStyle = '#5865f2'; ctx.fillRect(432, 50, 160, 160); }
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '56px "Noto Sans", "Noto Sans Arabic"';
  ctx.fillText(username, 512, 290);
  ctx.font = '32px "Noto Sans", "Noto Sans Arabic"';
  ctx.fillText(serverName, 512, 345);

  return canvas.toBuffer('image/png');
}
