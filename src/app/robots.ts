import type { MetadataRoute } from "next";

/** Ghost-Hub is a private tool; ask every crawler to stay away. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
