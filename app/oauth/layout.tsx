import type { ReactNode } from "react";

/**
 * The authorization screens stand outside the workspace shell on purpose: a
 * person deciding whether to connect a client should be looking at the decision
 * and not at a room.
 */
export default function OauthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page" id="main">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/mark.svg" alt="" width={34} height={34} />
          <span>Lepidy</span>
        </div>
        {children}
      </div>
    </main>
  );
}
