import './styles/app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { setLanguage } from '$tv/i18n.svelte';
import { settings } from '$tv/settings.svelte';
import { unlockOnFirstTouch } from './lib/media-element';
import { initLook } from './lib/look.svelte';
import { initDiagnostics } from './lib/diagnostics';
import { applyTheme } from './lib/theme';
import { trackViewportHeight } from './lib/viewport';
import { initUpdates } from './lib/updates.svelte';

// Before the first paint: the saved theme, not a flash of the default one.
applyTheme(settings.theme.value, settings.accent.value);
setLanguage(settings.language.value);
initDiagnostics();
initLook();
initUpdates();
unlockOnFirstTouch();
trackViewportHeight();
mount(App, { target: document.getElementById('app')! });
