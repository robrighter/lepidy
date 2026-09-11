import type { ReactNode } from "react";

import { MarketingAccessGate } from "@/components/marketing/marketing-access-gate";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <MarketingAccessGate>{children}</MarketingAccessGate>;
}
