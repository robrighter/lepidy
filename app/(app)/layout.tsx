import Link from "next/link";
import type { ReactNode } from "react";

import { ShellFrame } from "@/components/shell/shell-frame";
import { shellState } from "@/src/shell/shell-context";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const state = await shellState();

  if (state.status === "signed_out") {
    return (
      <main className="content" id="main">
        <div className="content-inner">
          <section className="panel empty-state">
            <h2>Sign in to Lepidy</h2>
            <p>This workspace needs a signed-in session before it can show you anything.</p>
            <Link className="primary-link" href="/signin">
              Go to sign in
            </Link>
          </section>
        </div>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="content" id="main">
        <div className="content-inner">
          <section className="panel empty-state">
            <h2>This workspace is unavailable</h2>
            <p>{state.reason}</p>
            <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
          </section>
        </div>
      </main>
    );
  }

  return (
    <ShellFrame
      workspaceName={state.workspace.name}
      plan={state.workspace.plan}
      viewer={state.snapshot.viewer}
      channels={state.snapshot.channels}
      agents={state.snapshot.agents}
      authenticated={state.authenticated}
    >
      {children}
    </ShellFrame>
  );
}
