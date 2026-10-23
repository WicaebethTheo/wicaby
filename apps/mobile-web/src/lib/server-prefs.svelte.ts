// The user's server-side configuration (the TV's lib/server-config.svelte.ts, with values of any JSON type: Emby's
// switches are booleans). A save that fails puts the old value back and says so.
import type { Api } from '$tv/api';

export class ServerPrefs {
  config = $state<Record<string, unknown> | null>(null);
  failed = $state(false);

  constructor(private readonly api: Api) {
    api.userConfiguration().then(
      (c) => (this.config = c),
      () => {},
    );
  }

  str(key: string): string {
    return String(this.config?.[key] ?? '');
  }

  async set(key: string, value: unknown): Promise<void> {
    const old = this.config;
    if (!old) return;
    this.config = { ...old, [key]: value };
    try {
      await this.api.setUserConfiguration(this.config);
      this.failed = false;
    } catch {
      this.failed = true;
      this.config = old;
    }
  }
}
