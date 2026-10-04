'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, PendingInvite } from '../../src/auth/invites.ts';
import { displayInstant } from '../../src/budget/month.ts';
import { copyText } from '../clipboard.ts';
import { createInviteAction, removeMemberAction, withdrawInviteAction } from './actions.ts';

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/**
 * Who can sign in, and the invitations that would add someone (NF-3).
 *
 * Everyone here sees and changes the same books, so there is nothing to grant:
 * the panel is only about the way in.
 */
export default function People({
  members,
  invites,
  currentUserId,
}: {
  members: Member[];
  invites: PendingInvite[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [made, setMade] = useState<{ name: string; link: string; expiresAt: Date } | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useCallback(() => {
    setError(null);
    setCopied(false);
    startTransition(async () => {
      const result = await createInviteAction(name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMade({ name: name.trim(), link: result.link, expiresAt: result.expiresAt });
      setName('');
      router.refresh();
    });
  }, [name, router]);

  const copy = useCallback(async () => {
    if (made) setCopied(await copyText(made.link));
  }, [made]);

  const withdraw = useCallback(
    (inviteId: string, forName: string) => {
      if (!window.confirm(`Withdraw the invitation for ${forName}? Its link will stop working.`)) {
        return;
      }
      startTransition(async () => {
        const result = await withdrawInviteAction(inviteId);
        if (!result.ok) setError(result.error);
        setMade(null);
        router.refresh();
      });
    },
    [router],
  );

  const remove = useCallback(
    (userId: string, memberName: string) => {
      if (
        !window.confirm(
          `Remove ${memberName}? Their passkeys and recovery codes stop working and they are ` +
            'signed out. Nothing they entered is touched.',
        )
      ) {
        return;
      }
      startTransition(async () => {
        const result = await removeMemberAction(userId);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  return (
    <section className="panel">
      <h3>People</h3>
      {error && <p className="signin-error">{error}</p>}

      {members.map((member) => (
        <div key={member.id} className="row device-row">
          <span>
            {member.name}
            {member.id === currentUserId && <span className="muted"> (you)</span>}
            <span className="muted"> · {plural(member.passkeys, 'passkey')}</span>
            <span className="muted"> · since {displayInstant(member.joinedAt)}</span>
          </span>
          {member.id !== currentUserId && (
            <span className="device-actions">
              <button onClick={() => remove(member.id, member.name)} disabled={pending}>
                Remove
              </button>
            </span>
          )}
        </div>
      ))}

      {invites.map((waiting) => (
        <div key={waiting.id} className="row device-row">
          <span>
            {waiting.name}
            <span className="muted"> · invited by {waiting.createdByName}</span>
            <span className="muted"> · link works until {displayInstant(waiting.expiresAt)}</span>
          </span>
          <span className="device-actions">
            <button onClick={() => withdraw(waiting.id, waiting.name)} disabled={pending}>
              Withdraw
            </button>
          </span>
        </div>
      ))}

      {made ? (
        <>
          <p className="muted">
            Send this link to {made.name} somewhere private, like a text message. It works once,
            until {displayInstant(made.expiresAt)}, and this is the only time it can be shown.
          </p>
          <div className="add-device">
            <input
              value={made.link}
              readOnly
              aria-label={`Invitation link for ${made.name}`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button className="primary" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button onClick={() => setMade(null)}>Done</button>
          </div>
        </>
      ) : (
        <div className="add-device">
          <input
            value={name}
            placeholder="Who is it for?"
            aria-label="Name of the person to invite"
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="primary"
            onClick={invite}
            disabled={pending || name.trim().length === 0}
          >
            Invite
          </button>
        </div>
      )}
      <p className="muted footnote">
        Everyone here sees and changes the same budget, and anyone can invite or remove anyone else.
        Each person has their own passkeys and recovery codes.
      </p>
    </section>
  );
}
