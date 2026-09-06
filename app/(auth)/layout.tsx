import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
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
