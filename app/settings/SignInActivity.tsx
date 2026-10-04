import Link from 'next/link';
import { describeActivity, type Activity } from '../../src/auth/activity.ts';
import { displayInstant } from '../../src/budget/month.ts';

/** The time of day an event happened, in the server's zone like every other date here. */
const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The household's recent sign-in activity, newest first (NF-3). Rendered on the
 * server, so the times are the server's and nothing differs on hydration.
 */
export default function SignInActivity({ events }: { events: Activity[] }) {
  return (
    <section className="panel" id="sign-in-activity">
      <h3>Sign-in activity</h3>
      {events.length === 0 && <p className="muted">Nothing yet.</p>}
      {events.map((event) => (
        <div key={event.id} className="row device-row">
          <span>
            {describeActivity(event)}
            <span className="muted">
              {' '}
              · {displayInstant(event.at)}, {timeOfDay.format(event.at)}
            </span>
          </span>
        </div>
      ))}
      <p className="muted footnote">
        Passkeys added and removed, recovery codes used or tried, and people invited, joining or
        removed. Signing in with a passkey is not listed: that is what is supposed to happen.
        {' '}Turn on Sign-in activity in your <Link href="/settings/you">notifications</Link> to have each
        sent to your phone as it happens.
        {process.env.MANILLA_ALERT_URL && ' Each is also sent to the alert webhook.'}
      </p>
    </section>
  );
}
