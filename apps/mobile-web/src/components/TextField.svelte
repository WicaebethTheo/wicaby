<script lang="ts">
  // A text field as iOS draws it in a form: a filled rounded field, the label as placeholder.
  import type { HTMLInputAttributes } from 'svelte/elements';

  let { value = $bindable(''), label, field = $bindable(), ...rest }: { value?: string; label: string; field?: HTMLInputElement } & Omit<HTMLInputAttributes, 'value'> = $props();
</script>

<label class="field">
  <span class="sr-only">{label}</span>
  <input bind:this={field} bind:value placeholder={label} autocapitalize="off" autocorrect="off" spellcheck="false" {...rest} />
</label>

<style>
  .field {
    display: block;
  }
  input {
    width: 100%;
    height: 52px;
    padding: 0 16px;
    border-radius: var(--r-md);
    border: 0;
    outline: none;
    background: var(--fill-2);
    color: var(--label);
    font-size: max(16px, var(--fs-body));
  }
  input::placeholder {
    color: var(--label-3);
  }
  input:focus {
    background: var(--fill-3);
  }
</style>
