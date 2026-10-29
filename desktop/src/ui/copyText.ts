/** Text put on the clipboard from a press: the page's clipboard API is one of the permissions the window is refused (electron/main.ts). */
export function copyText(text: string): void {
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}
