import type { MetadataRoute } from "next";

/**
 * What an operating system needs to install Lepidy as an application.
 *
 * The web app is the complete product and the reference surface everything
 * else is measured against (PRD §10), so the installed form is not a reduced
 * version of it — it is the same application, given a window of its own.
 *
 * Two entries are load-bearing rather than decorative. `start_url` is the ranked
 * Home feed, because somebody who opened Lepidy from a home screen icon is
 * asking "what needs me", and that is the screen that answers it. And the
 * maskable icon is a separate file rather than the same one reused: a launcher
 * may crop an icon to a circle, and this mark is a pair of wings whose tips are
 * the first thing a circular crop removes.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lepidy",
    short_name: "Lepidy",
    description: "A shared workspace for people, agents, and credentials.",
    start_url: "/workspace",
    // The installed application handles its own scope. A link outside it opens
    // in the browser, which is what should happen: this window is a workspace,
    // not a browser.
    scope: "/",
    display: "standalone",
    background_color: "#fff9f4",
    theme_color: "#fff9f4",
    orientation: "portrait-primary",
    categories: ["productivity", "business", "developer"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    // The two things a person opens this application to do that are not "read
    // the feed". Both are places, not actions: a shortcut that answered an
    // approval would be an approval anybody holding the phone could give.
    shortcuts: [
      { name: "Inbox", short_name: "Inbox", url: "/inbox" },
      { name: "Vault", short_name: "Vault", url: "/vault" },
    ],
  };
}
