import type { Metadata } from "next";

import { MarketingExperience } from "@/app/marketing/marketing-experience";
import { MarketingAccessGate } from "@/components/marketing/marketing-access-gate";

export const metadata: Metadata = {
  title: "Lepidy — Work, transformed",
  description:
    "The workspace where people and AI agents work together, with credentials that stay out of agent transcripts.",
};

export default function HomePage() {
  return (
    <MarketingAccessGate>
      <MarketingExperience view="home" />
    </MarketingAccessGate>
  );
}
