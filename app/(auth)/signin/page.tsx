import { AuthForm } from "@/components/shell/auth-form";
import { signInWithPassword } from "../actions";

export default function SignInPage() {
  return (
    <AuthForm
      action={signInWithPassword}
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
