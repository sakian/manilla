/**
 * One line to a phone, through ntfy (https://ntfy.sh, or your own).
 *
 * ntfy takes a plain-text POST as the notification's body and reads the rest
 * from headers: `Title`, `Priority` and `Click`, the page a tap opens. Any other
 * webhook that takes plain text gets the same line and ignores the headers.
 *
 * Never throws and never waits long: a notification is a courtesy, and the
 * thing that sent it - a sign-in, the nightly sync - must not fail or stall
 * because a phone could not be told about it.
 */

export type Push = {
  title: string;
  /** ntfy's names; `high` makes a phone sound even when it would not otherwise. */
  priority?: 'high' | 'default' | 'low';
  /** An absolute URL to open when the notification is tapped. */
  click?: string;
};

export async function push(url: string, text: string, options: Push): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    title: options.title,
  };
  if (options.priority) headers.priority = options.priority;
  if (options.click) headers.click = options.click;
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: text,
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.warn(`[manilla] the notification webhook answered ${response.status}`);
  } catch (error) {
    console.warn(`[manilla] the notification webhook could not be reached: ${String(error)}`);
  }
}
