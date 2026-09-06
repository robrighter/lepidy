import { describe, expect, it } from "vitest";
import { parseRemoteLocalAgentTrigger } from "./local-agent-trigger";

const valid = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  deviceId: "device-1",
  presetId: "preset-1",
  configRevision: 7,
  requestId: "request-1",
};

describe("remote local-agent triggers", () => {
  it("RUNNER-SEC-001 accepts only an opaque reference to locally approved configuration", () => {
    expect(parseRemoteLocalAgentTrigger(valid)).toEqual(valid);
  });

  it.each([
    ["script", "deploy.ps1"],
    ["command", "rm -rf /"],
    ["executable", "powershell.exe"],
    ["arguments", ["-File", "deploy.ps1"]],
    ["workingDirectory", "/srv/app"],
    ["environment", { TOKEN: "value" }],
    ["permissionMode", "unsafe"],
    ["limits", { maxStarts: 1000 }],
  ])("RUNNER-SEC-002 rejects remote %s overrides", (key, override) => {
    expect(() => parseRemoteLocalAgentTrigger({ ...valid, [key]: override })).toThrow(
      /remote launch configuration is forbidden/,
    );
  });
});
