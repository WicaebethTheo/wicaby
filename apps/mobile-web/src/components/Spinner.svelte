<script lang="ts">
  let { size = 24 }: { size?: number } = $props();
</script>

<span class="spin" style:width="{size}px" style:height="{size}px" role="progressbar" aria-label="…"></span>

<style>
  .spin {
    display: inline-block;
    border-radius: 50%;
    border: 2.5px solid currentColor;
    border-right-color: transparent;
    opacity: 0.7;
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
  }
</style>
