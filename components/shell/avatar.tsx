import { avatarGradient, initials } from "@/src/shell/shell-model";

/**
 * Generated from the name, never a stock photograph of a person, and stable so
 * the same principal looks the same on every surface.
 */
export function Avatar({
  name,
  size = 25,
  round = false,
}: {
  name: string;
  size?: number;
  round?: boolean;
}) {
  const [from, to] = avatarGradient(name);
  return (
    <span
      aria-hidden="true"
      className={`avatar${round ? " round" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `linear-gradient(135deg, ${from}, ${to})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

/** An agent wears the mark on a tinted tile: a person must never be mistaken for one. */
export function AgentAvatar({ size = 25 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="avatar agent" style={{ width: size, height: size }}>
      <img src="/mark.svg" alt="" width={Math.round(size * 0.68)} height={Math.round(size * 0.68)} />
    </span>
  );
}
