'use client';

/**
 * What the household has written about a transaction, and a way to add to it
 * (RQ-7).
 *
 * Oldest first, as it would be read: a note, the note left in handing it over,
 * the replies. Writing is sent at once rather than staged with any envelope
 * decision: it is said to someone, and on a handed-over row they are told.
 * Your own messages can be changed or taken back; everyone else's are theirs.
 *
 * Where the button that starts writing goes is the screen's to decide - in the
 * review queue it sits with the row's other controls - so `Thread` is told
 * whether to show the box, and `threadPrompt` says what the button reads.
 * `ThreadWithButton` is the two together, for a screen with nowhere better.
 */

import { useState, useTransition } from 'react';
import type { Message } from '../src/transactions/thread.ts';
import { NOTE_LIMIT } from '../src/transactions/limits.ts';
import { editMessageAction, removeMessageAction, writeAboutAction } from './actions.ts';

export type ThreadPeople = {
  me: string;
  /** The handover, when there was one, so writing knows who it is for. */
  handedToId: string | null;
  handedById: string | null;
  /** Members by id. */
  names: Record<string, string>;
};

/** Whoever is at the other end of the handover, by name: none when the row was not handed over. */
function otherEnd(people: ThreadPeople): { id: string; name: string } | null {
  if (!people.handedToId) return null;
  const id = people.me === people.handedById ? people.handedToId : people.handedById;
  if (!id || id === people.me) return null;
  const name = people.names[id];
  return name ? { id, name } : null;
}

/** What the button that starts writing says. */
export function threadPrompt(messages: Message[], people: ThreadPeople): string {
  const other = otherEnd(people);
  if (other) {
    return messages.some((message) => message.authorId === other.id)
      ? `Reply to ${other.name}`
      : `Write to ${other.name}`;
  }
  return messages.length === 0 ? 'Add a note' : 'Add to the notes';
}

export function Thread({
  transactionId,
  messages,
  setMessages,
  people,
  writing,
  onDoneWriting,
}: {
  transactionId: string;
  messages: Message[];
  setMessages: (update: (current: Message[]) => Message[]) => void;
  people: ThreadPeople;
  writing: boolean;
  onDoneWriting: () => void;
}) {
  const [draft, setDraft] = useState('');
  /** Which of your own messages is being changed, and to what. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const other = otherEnd(people);

  if (messages.length === 0 && !writing) return null;

  const send = () => {
    setError(null);
    startBusy(async () => {
      const result = await writeAboutAction(transactionId, draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessages((current) => [...current, result.message]);
      setDraft('');
      onDoneWriting();
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    setError(null);
    startBusy(async () => {
      const result = await editMessageAction(editing.id, editing.text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessages((current) => current.map((message) => (message.id === editing.id ? result.message : message)));
      setEditing(null);
    });
  };

  const remove = (id: string) => {
    setError(null);
    startBusy(async () => {
      const result = await removeMessageAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessages((current) => current.filter((message) => message.id !== id));
    });
  };

  return (
    <div className={`thread${other || messages.some((message) => message.authorId !== people.me) ? ' shared' : ''}`}>
      {messages.length > 0 && (
        <ol>
          {messages.map((message) =>
            editing?.id === message.id ? (
              <li key={message.id} className="thread-compose">
                <textarea
                  rows={2}
                  maxLength={NOTE_LIMIT}
                  autoFocus
                  value={editing.text}
                  aria-label="Your message"
                  onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                />
                <span className="allocation-actions">
                  <button className="primary" onClick={saveEdit} disabled={busy || editing.text.trim() === ''}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditing(null)} disabled={busy}>
                    Cancel
                  </button>
                </span>
              </li>
            ) : (
              <li key={message.id}>
                {/* A note from before anyone's name was kept - most came over
                    from GoodBudget - is just the note. */}
                {message.authorId === people.me ? (
                  <strong>You </strong>
                ) : (
                  message.authorName && <strong>{message.authorName} </strong>
                )}
                {message.body}
                {message.editedAt && <span className="muted"> (changed)</span>}
                {message.authorId === people.me && (
                  <span className="thread-own">
                    <button
                      className="link-button"
                      onClick={() => setEditing({ id: message.id, text: message.body })}
                      disabled={busy}
                    >
                      Change
                    </button>
                    <button className="link-button" onClick={() => remove(message.id)} disabled={busy}>
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {error && <p className="signin-error">{error}</p>}
      {writing && (
        <div className="thread-compose">
          <textarea
            rows={2}
            maxLength={NOTE_LIMIT}
            autoFocus
            value={draft}
            aria-label={other ? `Message for ${other.name}` : 'Note'}
            placeholder={other ? `For ${other.name}` : 'Anything worth remembering about this one'}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="allocation-actions">
            <button className="primary" onClick={send} disabled={busy || draft.trim() === ''}>
              {busy ? 'Sending…' : other ? 'Send' : 'Save note'}
            </button>
            <button
              onClick={() => {
                setDraft('');
                onDoneWriting();
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** The thread with its own button beneath it, for a screen with nowhere better to put one. */
export function ThreadWithButton({
  transactionId,
  messages: initial,
  people,
}: {
  transactionId: string;
  messages: Message[];
  people: ThreadPeople;
}) {
  const [messages, setMessages] = useState(initial);
  const [writing, setWriting] = useState(false);
  return (
    <div className="thread-block">
      <Thread
        transactionId={transactionId}
        messages={messages}
        setMessages={setMessages}
        people={people}
        writing={writing}
        onDoneWriting={() => setWriting(false)}
      />
      {!writing && (
        <button type="button" className="link-button" onClick={() => setWriting(true)}>
          {threadPrompt(messages, people)}
        </button>
      )}
    </div>
  );
}
