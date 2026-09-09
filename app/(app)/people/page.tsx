import { Avatar } from "@/components/shell/avatar";
import { randomSecret } from "@/src/domain/mcp-oauth";
import { formatLocalTime, formatWorkingHours, ownershipTransferConfirmation, presenceLabel } from "@/src/domain/people";
import { workspacePeople } from "@/src/shell/people-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import {
  administerMemberAction,
  archiveGroupAction,
  createGroupAction,
  invitationAction,
  inviteMemberAction,
  replaceGroupMembersAction,
} from "./actions";

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const state = await workspacePeople();
  const notice = (await searchParams).notice;
  if (state.status !== "ready") return (
    <section className="empty-state"><h2>People are unavailable</h2><p>{state.status === "unavailable" ? state.reason : "Sign in to see this workspace."}</p></section>
  );
  const csrfToken = (await readCsrfToken()) ?? "";
  const now = new Date();
  const viewer = state.directory.people.find((person) => person.id === state.viewerMemberId);
  const canAdminister = state.administration !== null;

  return (
    <>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <section className="panel">
        <h2>People</h2>
        <p>Workspace-local profiles, live presence and working hours. Removed members remain as attributed tombstones for administrators.</p>
      </section>
      <section className="people-grid" aria-label="People directory">
        {state.directory.people.map((person) => (
          <article className="panel person-card" key={person.id} data-member-status={person.status}>
            <div className="person-heading"><Avatar name={person.displayName} size={42} round /><div><h3>{person.displayName}</h3><p>@{person.handle} · {person.role}</p></div><span className={`presence-dot ${person.presence}`} title={presenceLabel(person.presence)}><span className="visually-hidden">{presenceLabel(person.presence)}</span></span></div>
            <p>{person.customStatus ?? person.title ?? "No status set"}</p>
            <div className="person-meta"><span>{formatLocalTime(person.timezone, now)}</span><span>{formatWorkingHours(person.workingStartMinute, person.workingEndMinute)}</span><span>{person.ownedAgentCount} agent{person.ownedAgentCount === 1 ? "" : "s"}</span></div>
            {person.status !== "active" ? <span className="tag">{person.status}</span> : null}
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Groups</h2>
        <p>Groups use the reserved <code>@g.</code> namespace. Anyone may create one; its creator or an administrator maintains it.</p>
        <form action={createGroupAction} className="settings-form">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="idempotencyKey" value={`group:${randomSecret(12)}`} />
          <label>Handle<input name="handle" required placeholder="g.platform" /></label>
          <label>Name<input name="displayName" required maxLength={120} placeholder="Platform" /></label>
          <label>Description<input name="description" maxLength={250} /></label>
          <fieldset><legend>Members</legend><div className="check-grid">{state.directory.people.filter((person) => person.status === "active").map((person) => <label key={person.id}><input type="checkbox" name="memberId" value={person.id} /> {person.displayName}</label>)}</div></fieldset>
          <button className="primary-link" type="submit">Create group</button>
        </form>
        <div className="group-list">
          {state.directory.groups.map((group) => {
            const editable = canAdminister || group.createdByMemberId === viewer?.id;
            return <article className="subpanel" key={group.id}>
              <h3>@{group.handle}</h3><p>{group.displayName} · {group.memberIds.length} active member{group.memberIds.length === 1 ? "" : "s"}</p>
              {group.description ? <p>{group.description}</p> : null}
              {editable ? <>
                <form action={replaceGroupMembersAction} className="settings-form compact">
                  <input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="groupId" value={group.id} />
                  <fieldset><legend>Membership</legend><div className="check-grid">{state.directory.people.filter((person) => person.status === "active").map((person) => <label key={person.id}><input type="checkbox" name="memberId" value={person.id} defaultChecked={group.memberIds.includes(person.id)} /> {person.displayName}</label>)}</div></fieldset>
                  <button type="submit">Save members</button>
                </form>
                <form action={archiveGroupAction}><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="groupId" value={group.id} /><button className="danger-link" type="submit">Archive group</button></form>
              </> : null}
            </article>;
          })}
          {state.directory.groups.length === 0 ? <p className="muted">No groups yet.</p> : null}
        </div>
      </section>

      {state.administration ? <section className="panel" id="administration">
        <h2>Workspace administration</h2>
        <form action={inviteMemberAction} className="settings-form">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <label>Email<input name="email" type="email" required /></label>
          <label>Invitation role<select name="role" defaultValue="member"><option value="member">Member</option><option value="guest">Guest</option><option value="admin">Admin</option></select></label>
          <button className="primary-link" type="submit">Invite person</button>
        </form>
        <h3>Waiting to join</h3>
        <div className="admin-list">{state.administration.invitations.map((invite) => <div className="admin-row" key={invite.id}><span>{invite.email} · {invite.role}</span><span>{invite.deliveryState === "held_for_plan" ? "Held for seat confirmation" : "Ready for delivery"}</span><form action={invitationAction}><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="invitationId" value={invite.id} />{invite.deliveryState === "held_for_plan" ? <button name="intent" value="confirm_plan">Confirm seat change</button> : null}<button name="intent" value="cancel">Cancel</button></form></div>)}</div>
        <h3>Roles and offboarding</h3>
        <div className="admin-list">{state.administration.members.map((member) => { const handle = state.directory.people.find((person) => person.id === member.memberId)?.handle ?? member.memberId; return <div className="admin-row" key={member.memberId}><span>{member.displayName}<small>{member.email} · {member.status}</small></span><form action={administerMemberAction}><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="memberId" value={member.memberId} /><select aria-label={`Role for ${member.displayName}`} name="role" defaultValue={member.role}><option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option><option value="guest">Guest</option></select><button name="intent" value="role">Save role</button>{member.status === "active" ? <button className="danger-link" name="intent" value="remove">Offboard</button> : <button name="intent" value="restore">Restore</button>}</form>{member.role !== "owner" && member.status === "active" ? <form action={administerMemberAction} className="transfer-form"><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="memberId" value={member.memberId} /><label>Type <code>{ownershipTransferConfirmation(handle)}</code><input name="confirmation" /></label><button name="intent" value="transfer">Transfer ownership</button></form> : null}</div>; })}</div>
      </section> : null}
    </>
  );
}
