import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // r218: every /api route serves LIVE state (vault slots, automation sync
  // heartbeats, gateway pulse, tracker). None of them shipped a Cache-Control
  // header, so browsers could heuristically cache an empty/stale answer and
  // replay it to later mounts — the vault card was observed rendering
  // "No registry-provider key stored" while the DB held the row (r218 QA).
  // One blanket no-store closes the whole class; nothing under /api is
  // cacheable-by-design. Static assets under /_next/static are untouched.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
