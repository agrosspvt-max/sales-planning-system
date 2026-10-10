import Link from "next/link";

/**
 * A calendar entry's link into Party Planning. While PARTY_PLANNING_ENABLED is off it renders the same content as plain text (no link, so no
 * normal navigation reaches the disabled module); the server blocks the pages and APIs regardless.
 */
export function PartyLink({ enabled, href = "/planning/party/view", className, children }: { enabled: boolean; href?: string; className?: string; children: React.ReactNode }) {
  return enabled
    ? <Link href={href} className={`${className ?? ""} hover:underline`.trim()}>{children}</Link>
    : <div className={className} data-party-planning-disabled>{children}</div>;
}
