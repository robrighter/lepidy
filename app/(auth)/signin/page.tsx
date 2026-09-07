import { AuthForm } from "@/components/shell/auth-form";
import { signInWithPassword } from "../actions";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // Carried through so somebody sent here by an MCP client's authorization
  // request lands back on the consent screen rather than on their inbox.
  const { next } = await searchParams;
  return (
    <AuthForm
      action={signInWithPassword}
      next={typeof next === "string" ? next : undefined}
      title="Sign in"
      intro="Your workspace, its agents and its credentials."
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]}
      submitLabel="Sign in"
      footer="No account yet?"
      footerHref="/signup"
      footerLabel="Create one"
    />
  );
}
