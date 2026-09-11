import type { Metadata } from "next";

import { MarketingExperience } from "./marketing-experience";

export const metadata: Metadata = {
  title: "Lepidy — Work, transformed",
  description:
    "The workspace where people and AI agents work together, with credentials that stay out of agent transcripts.",
};

export default function MarketingPage() {
  return <MarketingExperience view="home" />;
}
