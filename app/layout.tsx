import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Lepidy",
  description: "A shared workspace for people, agents, and credentials.",
  icons: [{ rel: "icon", url: "/mark.svg" }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
