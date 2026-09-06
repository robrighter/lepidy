import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

export type RegisteredPasskey = WebAuthnCredential;

export interface PasskeyProvider {
  registrationOptions(input: {
    accountId: string;
    email: string;
    displayName: string;
    existing: { id: string; transports?: string[] }[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(response: unknown, challenge: string): Promise<RegisteredPasskey | null>;
  authenticationOptions(existing: { id: string; transports?: string[] }[]): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(
    response: unknown,
    challenge: string,
    credential: RegisteredPasskey,
  ): Promise<number | null>;
}

export class SimpleWebAuthnPasskeyProvider implements PasskeyProvider {
  constructor(
    private readonly rpId = "app.lepidy.com",
    private readonly origins: string[] = ["https://app.lepidy.com"],
  ) {}

  registrationOptions(input: {
    accountId: string;
    email: string;
    displayName: string;
    existing: { id: string; transports?: string[] }[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: "Lepidy",
      rpID: this.rpId,
      userID: new TextEncoder().encode(input.accountId),
      userName: input.email,
      userDisplayName: input.displayName,
      attestationType: "none",
      excludeCredentials: input.existing,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });
  }

  async verifyRegistration(response: unknown, challenge: string): Promise<RegisteredPasskey | null> {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: this.origins,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    });
    return result.verified ? result.registrationInfo.credential : null;
  }

  authenticationOptions(
    existing: { id: string; transports?: string[] }[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: existing,
      userVerification: "required",
    });
  }

  async verifyAuthentication(
    response: unknown,
    challenge: string,
    credential: RegisteredPasskey,
  ): Promise<number | null> {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: this.origins,
      expectedRPID: this.rpId,
      credential,
      requireUserVerification: true,
    });
    return result.verified ? result.authenticationInfo.newCounter : null;
  }
}
