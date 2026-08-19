import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeGalaxy from "starlight-theme-galaxy";

export default defineConfig({
  site: "https://rennerdo30.github.io/better-tab-unload",
  base: "/better-tab-unload",
  integrations: [
    starlight({
      title: "Better Tab Unload",
      description:
        "Chrome extension that shows a cached screenshot while a discarded tab is restored",
      plugins: [starlightThemeGalaxy()],
      customCss: ["./src/styles/custom.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/rennerdo30/better-tab-unload" },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Configuration", slug: "getting-started/configuration" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "How It Works", slug: "guides/architecture" },
            { label: "Privacy", slug: "guides/privacy" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
