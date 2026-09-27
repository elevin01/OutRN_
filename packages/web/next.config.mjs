/** @type {import('next').NextConfig} */
const nextConfig = {
  // The UI's only workspace dependency. Engine, database and ingestion packages must never be imported here
  // (scripts/check-boundaries.mjs enforces it in CI).
  transpilePackages: ["@outrn/contracts"],
};

export default nextConfig;
