/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@outrn/core", "@outrn/db", "@outrn/engine", "@outrn/facts"],
  serverExternalPackages: ["pg", "opening_hours"],
};

export default nextConfig;
