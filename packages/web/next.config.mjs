/**
 * Sent with every page. No page may be framed (the ops pages sit behind a Basic-auth prompt, so
 * framing would invite clickjacking), types are never sniffed, and outbound links to venue sites
 * and Maps carry only our origin, not the search in the URL.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The UI's only workspace dependency. Engine, database and ingestion packages must never be imported here
  // (scripts/check-boundaries.mjs enforces it in CI).
  transpilePackages: ["@outrn/contracts"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
