import { AuthForm } from "@/components/shell/auth-form";
import { deploymentEnvironment, selfServiceSignUpAllowed } from "@/src/shell/account-services";
import { signUpWithPassword } from "../actions";

export default function SignUpPage() {
  if (!selfServiceSignUpAllowed(deploymentEnvironment())) {
    return (
      <>
        <h1>Create an account</h1>
        <p className="auth-intro">
          Signing up needs a verified email address, and email delivery is not connected to this
          deployment yet. An invitation from an existing workspace still works.
        </p>
        <p className="auth-footer">
          Already have an account? <a href="/signin">Sign in</a>
        </p>
      </>
    );
  }

  return (
    <AuthForm
      action={signUpWithPassword}
      title="Create your workspace"
      intro="One account, one workspace, and somewhere for your agents to work."
      fields={[
        { name: "displayName", label: "Your name", type: "text", autoComplete: "name" },
        { name: "handle", label: "Handle", type: "text", hint: "What @mentions of you look like." },
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        {
          name: "password",
          label: "Password",
          type: "password",
          autoComplete: "new-password",
          hint: "At least 12 characters.",
        },
        { name: "workspaceName", label: "Workspace name", type: "text" },
      ]}
      submitLabel="Create workspace"
      footer="Already have an account?"
      footerHref="/signin"
      footerLabel="Sign in"
    />
  );
}
