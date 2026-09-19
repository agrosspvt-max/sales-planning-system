import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  // The user's home directory also contains a package-lock.json. Declare this repository explicitly so Next
  // does not infer /Users/rahmani as the workspace root or trace unrelated files above the project.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
