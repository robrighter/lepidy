import type { Metadata } from "next";

import { MarketingExperience } from "../marketing-experience";

export const metadata: Metadata = {
  title: "Download — Lepidy",
  description: "Get Lepidy for macOS, iPhone, and Windows.",
};

export default function DownloadPage() {
  return <MarketingExperience view="download" />;
}
