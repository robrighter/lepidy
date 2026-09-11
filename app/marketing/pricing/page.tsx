import type { Metadata } from "next";

import { MarketingExperience } from "../marketing-experience";

export const metadata: Metadata = {
  title: "Pricing — Lepidy",
  description: "A complete free plan for individuals and simple workspace pricing for teams.",
};

export default function PricingPage() {
  return <MarketingExperience view="pricing" />;
}
