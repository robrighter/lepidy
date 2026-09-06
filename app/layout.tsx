import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { DesktopPlatform } from "@/components/shell/desktop-platform";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { ThemeScript } from "@/components/shell/theme-script";

export const metadata: Metadata = {
  title: "Lepidy",
  description: "A shared workspace for people, agents, and credentials.",
  icons: [{ rel: "icon", url: "/mark.svg" }],
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fff9f4" },
    { media: "(prefers-color-scheme: dark)", color: "#14122e" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <DesktopPlatform />
        <DesktopTitlebar />
        {children}
      </body>
    </html>
  );
}
