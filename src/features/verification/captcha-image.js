import { createCanvas } from '@napi-rs/canvas';
import { ensureFonts } from '../greet/card.js';

const W = 320;
const H = 110;
const COLORS = ['#c0392b', '#1f618d', '#117a65', '#7d3c98', '#b9770e', '#1b4f72', '#a93226', '#0e6655'];

export async function renderCaptcha(code, random = Math.random) {
  ensureFonts();
  const r = (a, b) => a + random() * (b - a);
  const pick = () => COLORS[Math.min(COLORS.length - 1, Math.floor(random() * COLORS.length))];
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#e9ecef';
  ctx.fillRect(0, 0, W, H);

  // behind the text: coloured curves and dots
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    ctx.strokeStyle = pick();
    ctx.beginPath();
    ctx.moveTo(r(0, 40), r(10, H - 10));
    ctx.bezierCurveTo(r(60, 140), r(0, H), r(180, 260), r(0, H), r(280, W), r(10, H - 10));
    ctx.stroke();
  }
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = pick();
    ctx.beginPath();
    ctx.arc(r(0, W), r(0, H), r(1, 2.2), 0, Math.PI * 2);
    ctx.fill();
  }

  // characters, each rotated and offset
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = W / (code.length + 1);
  for (let i = 0; i < code.length; i++) {
    ctx.save();
    ctx.translate(step * (i + 1) + r(-6, 6), H / 2 + r(-10, 10));
    ctx.rotate(r(-0.4, 0.4));
    ctx.font = `${Math.round(r(52, 64))}px "Noto Sans"`;
    ctx.fillStyle = pick();
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  // lines across the text
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = pick();
    ctx.beginPath();
    ctx.moveTo(r(0, 40), r(15, H - 15));
    ctx.lineTo(r(W - 40, W), r(15, H - 15));
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}
