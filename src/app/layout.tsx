import type { Metadata, Viewport } from 'next';
import { Barlow } from 'next/font/google';
import './globals.css';

/**
 * Barlow is Golden Sierra's typeface. The agency's site loads it at 400, 700
 * and 900; 500 and 600 are added here for dense admin labels. Self-hosted by
 * next/font, so there is no request to a font CDN and no flash of fallback
 * text.
 */
const barlow = Barlow({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  variable: '--font-barlow',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Workforce Navigator — Golden Sierra',
  description:
    'Find job search help, training, scholarships, paid internships and employer hiring support across Placer, El Dorado and Alpine counties.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The charcoal of the header, so mobile browser chrome continues it.
  themeColor: '#231f20',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={barlow.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
