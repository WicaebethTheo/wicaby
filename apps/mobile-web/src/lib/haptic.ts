// A light tap of the iPhone's Taptic Engine. Safari has no vibration API, but toggling an `<input switch>` (iOS 18+)
// gives the system's switch feedback: a hidden one, toggled through its label. Nothing elsewhere.
let label: HTMLLabelElement | null = null;

export function haptic(): void {
  if (!label) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'wicaby-haptic';
    label = document.createElement('label');
    label.htmlFor = input.id;
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-10px;top:-10px';
    label.appendChild(input);
    document.body.appendChild(label);
  }
  label.click();
}
