import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (Unraid deployment).
  output: "standalone",
};

export default nextConfig;
