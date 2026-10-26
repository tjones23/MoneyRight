import type { MetadataRoute } from "next";

/** Lets MoneyRight be added to a Home Screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MoneyRight",
    short_name: "MoneyRight",
    description: "Your balances and net worth, in one place.",
    start_url: "/",
    display: "standalone",
    background_color: "#08080b",
    theme_color: "#08080b",
    icons: [
      { src: "/icon/small", sizes: "192x192", type: "image/png" },
      { src: "/icon/large", sizes: "512x512", type: "image/png" },
      { src: "/icon/large", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
