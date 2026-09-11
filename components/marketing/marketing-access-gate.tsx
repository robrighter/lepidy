"use client";

import { usePathname } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import styles from "./marketing-access-gate.module.css";

const ACCESS_STORAGE_KEY = "lepidy-marketing-access";
const ACCESS_CODE = "8787";

export function MarketingAccessGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    setAllowed(window.localStorage.getItem(ACCESS_STORAGE_KEY) === ACCESS_CODE);
    setChecked(true);
  }, [pathname]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code !== ACCESS_CODE) {
      setError(true);
      return;
    }
    window.localStorage.setItem(ACCESS_STORAGE_KEY, ACCESS_CODE);
    setError(false);
    setAllowed(true);
  };

  if (!checked || !allowed) {
    return (
      <main className={styles.gate} id="main">
        <form className={styles.form} onSubmit={submit}>
          <img src="/mark.svg" alt="Lepidy" width={62} height={62} />
          <label htmlFor="marketing-access-code">Enter access code</label>
          <input
            id="marketing-access-code"
            name="accessCode"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, "").slice(0, 4));
              setError(false);
            }}
            aria-invalid={error}
            aria-describedby={error ? "marketing-access-error" : undefined}
            autoFocus={checked}
          />
          <button type="submit" disabled={code.length !== 4}>Enter</button>
          {error ? <p id="marketing-access-error" role="alert">That code isn’t recognized.</p> : null}
        </form>
      </main>
    );
  }

  return children;
}
