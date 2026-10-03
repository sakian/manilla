/**
 * Put text on the clipboard, from a press (#44).
 *
 * The Clipboard API is only offered to a secure page. The tailnet address is
 * HTTPS, but the dev server reached by LAN address is not, and copying should
 * not quietly stop working there - so the old way, a selected off-screen
 * textarea and `execCommand`, is the fallback. Says whether it worked, so the
 * screen never claims a copy that did not happen.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permissions, an unfocused page): try the old way.
    }
  }

  const returnFocus = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  returnFocus?.focus();
  return copied;
}
