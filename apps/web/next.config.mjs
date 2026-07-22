/** @type {import("next").NextConfig} */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const aaspaiPackages = [
  "@aaspai/contracts",
  "@aaspai/db",
  "@aaspai/file-loader",
  "@aaspai/observability",
  "@aaspai/sessions",
  "@aaspai/harness",
  "@aaspai/loops",
  "@aaspai/skills",
  "@aaspai/tools",
  "@aaspai/knowledge",
];

const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: { ignoreBuildErrors: false },
  // Tell Next.js to transpile workspace packages that use
  // TypeScript ESM `.js` import paths.
  transpilePackages: aaspaiPackages,
  // better-sqlite3 is a native module — keep webpack from trying to
  // bundle it.
  serverExternalPackages: ["better-sqlite3"],
  webpack(config) {
    // Allow `.js` import paths inside transpiled workspace packages
    // to resolve to their `.ts` source. ESM-friendly TypeScript
    // convention used by @aaspai/*.
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts"],
      ".mjs": [".mjs", ".mts"],
    };
    return config;
  },
  // Turbopack config (used when --turbopack flag is passed).
  experimental: {
    turbo: {
      resolveAlias: {
        // Same idea as webpack.extensionAlias, but for Turbopack.
        // Not strictly needed because we don't pass --turbopack by
        // default, but kept here for when we migrate.
      },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default nextConfig;
