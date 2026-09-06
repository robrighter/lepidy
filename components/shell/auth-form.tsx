"use client";

import Link from "next/link";
import { useActionState } from "react";

import type { AuthResult } from "@/app/(auth)/actions";

export type AuthField = {
  name: string;
  label: string;
  type: "text" | "email" | "password";
  autoComplete?: string;
  required?: boolean;
  hint?: string;
};

export function AuthForm({
  action,
  title,
  intro,
  fields,
  submitLabel,
  footer,
  footerHref,
  footerLabel,
}: {
  action: (previous: AuthResult | null, form: FormData) => Promise<AuthResult>;
  title: string;
  intro: string;
  fields: readonly AuthField[];
  submitLabel: string;
  footer: string;
  footerHref: string;
  footerLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <>
      <h1>{title}</h1>
      <p className="auth-intro">{intro}</p>
      <form action={formAction} className="auth-form">
        {fields.map((field) => (
          <label key={field.name}>
            <span>{field.label}</span>
            <input
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              required={field.required !== false}
            />
            {field.hint ? <em>{field.hint}</em> : null}
          </label>
        ))}
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Working" : submitLabel}
        </button>
        {state && !state.ok ? (
          <p className="auth-error" role="alert">
            {state.reason}
          </p>
        ) : null}
      </form>
      <p className="auth-footer">
        {footer} <Link href={footerHref}>{footerLabel}</Link>
      </p>
    </>
  );
}
