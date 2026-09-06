import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Autopilot',
  description: 'Daily job discovery, resume tailoring and assisted apply',
};

/**
 * themeColor matches the canvas so the mobile browser chrome blends into the
 * page instead of framing it in white. Two entries because the theme has two
 * canvases and the OS picks by its own setting - the in-app toggle cannot reach
 * the address bar.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0b0f' },
    { media: '(prefers-color-scheme: light)', color: '#f4f5f8' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `dark` is on the server-rendered html so the first paint is already the
    // default theme. suppressHydrationWarning is required because next-themes
    // rewrites this attribute before React hydrates.
    <html lang="en" className="dark" suppressHydrationWarning>
      {/* `ambient` paints the fixed radial wash behind everything. */}
      <body className="ambient min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
