import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.PI_NEXT_DIST_DIR || ".next",
  experimental: {
    cpus: 2,
    optimizePackageImports: ["@copilotkit/react-core/v2", "lucide-react"],
  },
  serverExternalPackages: [
    "@copilotkit/runtime",
    "@copilotkit/pi-agent",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
};

export default config;
