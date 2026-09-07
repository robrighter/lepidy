"use client";

import { useEffect, useState } from "react";

/**
 * False on the server and on the first client render, true once React has
 * hydrated this tree and its event handlers are attached.
 *
 * A form whose only submit path is an `onSubmit` handler does nothing useful
 * before hydration. The handler is not attached yet, so the browser performs
 * its own default submission instead: a GET to the current URL that reloads the
 * page and throws away everything that was typed, with no error to say so.
 *
 * Gating the submit button on this closes both routes into that state, because
 * a form with no enabled submit button also has no implicit submission when
 * somebody presses Enter in one of its fields. The button being briefly
 * unavailable says plainly that the page is not ready, which is true.
 *
 * Forms that must work before hydration use `<form action={serverAction}>` with
 * `useActionState` instead, the way the sign-in and sign-up forms do; React
 * posts those to the server itself when they are submitted early.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
