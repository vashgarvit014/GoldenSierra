import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The design tokens are the product's only source of colour, so the contrast
 * they produce is checked here rather than by eye. Each pair below is a
 * foreground actually set on that background somewhere in the UI.
 *
 * Thresholds are WCAG 2.2 AA: 4.5:1 for text, 3:1 for the boundary of a
 * control or a meaningful graphic (1.4.11).
 */

const css = readFileSync(path.resolve(__dirname, '../../src/app/globals.css'), 'utf8');

/** `--name: value;` pairs from the first `:root` block. */
function readTokens(): Map<string, string> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!root) throw new Error('No :root block found in globals.css');
  const tokens = new Map<string, string>();
  for (const m of root[1]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(m[1]!, m[2]!.trim());
  }
  return tokens;
}

const tokens = readTokens();

function resolve(name: string, depth = 0): string {
  const raw = tokens.get(name);
  if (!raw) throw new Error(`Token ${name} is not defined`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  if (ref) {
    if (depth > 8) throw new Error(`Token ${name} resolves in a cycle`);
    return resolve(ref[1]!, depth + 1);
  }
  return raw;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Expected a 6-digit hex colour, got "${hex}"`);
  const channel = (i: number) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(resolve(fg)), luminance(resolve(bg))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;

describe('brand primitives match the official reference', () => {
  // Read from goldensierra.com's theme presets and computed styles.
  it.each([
    ['--gs-gold', '#ffc425'],
    ['--gs-charcoal', '#231f20'],
    ['--gs-tobacco', '#6e5740'],
    ['--gs-canvas', '#f0eeeb'],
    ['--gs-success', '#28a745'],
    ['--gs-danger', '#dc3545'],
    ['--gs-warning', '#ffc107'],
    ['--gs-info', '#00a0cd'],
  ])('%s is %s', (token, value) => {
    expect(resolve(token).toLowerCase()).toBe(value);
  });
});

describe('text contrast (AA, 4.5:1)', () => {
  it.each([
    // Body copy and headings
    ['--foreground', '--background'],
    ['--foreground', '--muted'],
    ['--surface-foreground', '--surface'],
    // Secondary copy on every light surface it appears on
    ['--muted-foreground', '--background'],
    ['--muted-foreground', '--muted'],
    ['--muted-foreground', '--accent-soft'],
    // Links and tobacco headings
    ['--accent', '--background'],
    ['--accent', '--muted'],
    ['--accent', '--accent-soft'],
    ['--accent-foreground', '--accent'],
    // Landing hero copy on the gold field
    ['--foreground', '--primary'],
    // Primary button label, in all three states
    ['--primary-foreground', '--primary'],
    ['--primary-foreground', '--primary-hover'],
    ['--primary-foreground', '--primary-active'],
    // Charcoal surfaces: header, footer, sidebar, user messages
    ['--ink-foreground', '--ink'],
    ['--ink-muted', '--ink'],
    ['--primary', '--ink'],
    ['--ink-foreground', '--ink-raised'],
    ['--primary', '--ink-raised'],
    // Status text on its own tint, and on a plain card
    ['--success-strong', '--success-soft'],
    ['--success-strong', '--surface'],
    ['--warning-strong', '--warning-soft'],
    ['--warning-strong', '--surface'],
    ['--destructive-strong', '--destructive-soft'],
    ['--destructive-strong', '--surface'],
    ['--info-strong', '--info-soft'],
    ['--info-strong', '--surface'],
    // Solid destructive button
    ['--destructive-foreground', '--destructive'],
    ['--destructive-foreground', '--destructive-hover'],
  ])('%s on %s', (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(TEXT);
  });
});

describe('control and graphic contrast (AA, 3:1)', () => {
  it.each([
    // Input outlines against the surfaces inputs sit on
    ['--input', '--background'],
    ['--input', '--muted'],
    // Tobacco on gold is below 4.5:1, so it is reserved for the 60px hero headline
    // (large text, 3:1) — never body copy. Same pairing as goldensierra.com.
    ['--accent', '--primary'],
    // Focus ring: charcoal on light surfaces, gold on charcoal ones
    ['--focus', '--background'],
    ['--focus', '--muted'],
    ['--focus', '--primary'],
    ['--gs-gold', '--ink'],
    // Button borders
    ['--foreground', '--primary'],
    ['--accent', '--background'],
    // Status dots and progress fills read against a card
    ['--success', '--surface'],
    ['--destructive', '--surface'],
    ['--info', '--surface'],
  ])('%s against %s', (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(NON_TEXT);
  });
});

describe('token hygiene', () => {
  it('defines every semantic token the brief names', () => {
    for (const name of [
      'primary', 'primary-foreground', 'background', 'foreground', 'surface',
      'surface-foreground', 'muted', 'muted-foreground', 'border', 'input',
      'focus', 'success', 'warning', 'destructive',
    ]) {
      expect(tokens.has(`--${name}`), `--${name}`).toBe(true);
    }
  });

  it('keeps raw colours out of the semantic layer except documented approximations', () => {
    // A semantic token is either a reference to a primitive or carries a
    // comment saying why it is not. This stops ad-hoc hex values creeping in.
    const semantic = [...tokens].filter(([name]) => !name.startsWith('--gs-'));
    const rawHex = semantic.filter(([, value]) => /^#[0-9a-f]{3,8}$/i.test(value)).map(([n]) => n);
    const documented = new Set([
      '--muted-foreground', '--ink-muted', '--ink-border', '--ink-raised',
      '--success-soft', '--success-strong', '--success-border',
      '--warning-soft', '--warning-strong', '--warning-border',
      '--destructive-hover', '--destructive-soft', '--destructive-strong', '--destructive-border',
      '--info-soft', '--info-strong', '--info-border',
    ]);
    expect(rawHex.filter((n) => !documented.has(n))).toEqual([]);
  });
});
