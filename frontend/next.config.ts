import type { NextConfig } from 'next';

/**
 * No rewrite proxy to the API on purpose.
 *
 * The browser talks to the Nest API directly at NEXT_PUBLIC_API_URL, so the
 * session cookie is set by the origin that owns it and CORS + SameSite are
 * exercised in development exactly as they will be in production. A dev-only
 * proxy would hide cookie problems until deploy, which is the worst time to
 * find them.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // The dev badge is pinned bottom-left, which is exactly where the sidebar
  // footer puts the signed-in account and the sign-out button - it sits on top
  // of them and reads like a layout bug in screenshots. Dev-only affordance,
  // and the info it carries is already in the terminal.
  devIndicators: false,
};

export default nextConfig;
